<?php

// =====================================
// PAWRESCUE COMMUNITY
// UPLOAD PET PHOTO API
// =====================================

// CORS is handled automatically by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// JSON RESPONSE HELPER
// =====================================

function reply($status, $success, $message, $extra = [])
{
    http_response_code($status);

    echo json_encode(array_merge([
        "success" => $success,
        "message" => $message
    ], $extra));

    exit;
}

// =====================================
// REQUEST METHOD VALIDATION
// =====================================

// OPTIONS requests are already handled
// by centralized cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST, OPTIONS");
    reply(405, false, "Method not allowed.");
}

// =====================================
// AUTHENTICATION
// =====================================

require_once __DIR__ . "/../middleware/auth_middleware.php";

$destination = null;
$fileSaved = false;
$conn = null;

try {
    // Only residents can upload photos.
    $auth = authenticate(["resident"]);
    $conn = $auth["connection"];
    $userId = (int) $auth["user"]["id"];

    // =====================================
    // VALIDATE REPORT ID
    // =====================================

    $reportId = filter_var(
        $_POST["report_id"] ?? null,
        FILTER_VALIDATE_INT,
        ["options" => ["min_range" => 1]]
    );

    if (!$reportId) {
        reply(400, false, "Invalid report ID.");
    }

    // =====================================
    // VALIDATE UPLOADED PHOTO
    // =====================================

    // Each call uploads ONE photo. The app can
    // call this endpoint repeatedly, up to 10 photos.
    if (
        !isset($_FILES["photo"]) ||
        !is_array($_FILES["photo"]) ||
        is_array($_FILES["photo"]["error"] ?? null)
    ) {
        reply(400, false, "Please select a photo.");
    }

    $file = $_FILES["photo"];

    // =====================================
    // CHECK UPLOAD ERROR
    // =====================================

    if ($file["error"] !== UPLOAD_ERR_OK) {
        if (in_array($file["error"], [
            UPLOAD_ERR_INI_SIZE,
            UPLOAD_ERR_FORM_SIZE
        ], true)) {
            reply(413, false, "Uploaded photo is too large.");
        }

        reply(400, false, "Photo upload failed.");
    }

    // =====================================
    // VALIDATE FILE SIZE
    // =====================================

    // Maximum file size: 5 MB
    $maxSize = 5 * 1024 * 1024;

    if ($file["size"] <= 0 || $file["size"] > $maxSize) {
        reply(413, false, "Photo must not exceed 5 MB.");
    }

    // =====================================
    // VERIFY TEMPORARY UPLOAD FILE
    // =====================================

    $tmp = $file["tmp_name"];

    if (!is_uploaded_file($tmp)) {
        reply(400, false, "Invalid uploaded file.");
    }

    // =====================================
    // VERIFY IMAGE MIME TYPE
    // =====================================

    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = $finfo->file($tmp);

    $allowed = [
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp"
    ];

    if (!isset($allowed[$mime])) {
        reply(400, false, "Only JPG, PNG, and WebP images are allowed.");
    }

    // =====================================
    // VERIFY IMAGE CONTENT
    // =====================================

    $imageInfo = @getimagesize($tmp);

    if (!$imageInfo || $imageInfo["mime"] !== $mime) {
        reply(400, false, "Invalid image content.");
    }

    // =====================================
    // VALIDATE IMAGE DIMENSIONS
    // =====================================

    $width = (int) $imageInfo[0];
    $height = (int) $imageInfo[1];

    if ($width < 1 || $height < 1 || $width > 6000 || $height > 6000) {
        reply(400, false, "Invalid image dimensions.");
    }

    // =====================================
    // LOCATE PROJECT ROOT
    // =====================================

    $projectRoot = realpath(dirname(__DIR__));

    if ($projectRoot === false || !is_dir($projectRoot)) {
        throw new RuntimeException("PawRescue API root directory was not found.");
    }

    // =====================================
    // PREPARE UPLOAD DIRECTORIES
    // =====================================

    $uploadsDir = $projectRoot . DIRECTORY_SEPARATOR . "uploads";
    $uploadDir = $uploadsDir . DIRECTORY_SEPARATOR . "pets";

    if (!is_dir($uploadsDir)) {
        if (!@mkdir($uploadsDir, 0755, true) && !is_dir($uploadsDir)) {
            throw new RuntimeException("Cannot create uploads directory.");
        }
    }

    if (!is_dir($uploadDir)) {
        if (!@mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
            throw new RuntimeException("Cannot create pets directory.");
        }
    }

    if (!is_writable($uploadDir)) {
        throw new RuntimeException("Upload directory is not writable.");
    }

    // =====================================
    // GENERATE RANDOM FILE NAME
    // =====================================

    $extension = $allowed[$mime];
    $filename = bin2hex(random_bytes(16)) . "." . $extension;
    $destination = $uploadDir . DIRECTORY_SEPARATOR . $filename;

    // Preserve the existing path format for
    // compatibility with current mobile screens.
    $photoPath = "/pawrescue_api/uploads/pets/" . $filename;

    // =====================================
    // VERIFY OWNERSHIP, STATUS AND LIMIT
    // =====================================

    // Lock the report row to prevent simultaneous
    // uploads from bypassing the 10-photo limit.
    $conn->beginTransaction();

    $stmt = $conn->prepare(
        "SELECT id, photo_path, status
         FROM pet_reports
         WHERE id = :report_id
           AND user_id = :user_id
           AND report_type IN ('lost', 'found')
         LIMIT 1
         FOR UPDATE"
    );

    $stmt->execute([
        ":report_id" => $reportId,
        ":user_id" => $userId
    ]);

    $report = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$report) {
        $conn->rollBack();
        reply(404, false, "Report not found or access denied.");
    }

    if (!in_array($report["status"], ["pending", "under_review", "in_progress"], true)) {
        $conn->rollBack();
        reply(409, false, "Photos cannot be added to resolved or closed reports.");
    }

    $countStmt = $conn->prepare(
        "SELECT COUNT(*)
         FROM pet_report_photos
         WHERE report_id = :report_id"
    );
    $countStmt->execute([":report_id" => $reportId]);
    $photoCount = (int) $countStmt->fetchColumn();

    if ($photoCount >= 10) {
        $conn->rollBack();
        reply(409, false, "A report can contain a maximum of 10 photos.", [
            "photo_count" => $photoCount,
            "max_photos" => 10
        ]);
    }

    // =====================================
    // SAVE PHOTO FILE
    // =====================================

    if (!move_uploaded_file($tmp, $destination)) {
        throw new RuntimeException("Unable to save uploaded photo.");
    }
    $fileSaved = true;

    // =====================================
    // INSERT NEW PHOTO RECORD
    // =====================================

    $insert = $conn->prepare(
        "INSERT INTO pet_report_photos (report_id, photo_path, sort_order)
         VALUES (:report_id, :photo_path, :sort_order)"
    );

    $insert->execute([
        ":report_id" => $reportId,
        ":photo_path" => $photoPath,
        ":sort_order" => $photoCount
    ]);

    $photoId = (int) $conn->lastInsertId();

    // Keep the first photo in the legacy field so
    // existing My Reports and feed pages still work.
    // Subsequent photos are appended, never replaced.
    if (empty($report["photo_path"])) {
        $update = $conn->prepare(
            "UPDATE pet_reports
             SET photo_path = :photo_path
             WHERE id = :report_id AND user_id = :user_id"
        );

        $update->execute([
            ":photo_path" => $photoPath,
            ":report_id" => $reportId,
            ":user_id" => $userId
        ]);
    }

    $conn->commit();

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    reply(200, true, "Pet photo uploaded successfully!", [
        "report_id" => (int) $reportId,
        "photo_id" => $photoId,
        "photo_path" => $photoPath,
        "photo_count" => $photoCount + 1,
        "max_photos" => 10
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    // Remove only the newly created file when
    // inserting its database record fails.
    if ($fileSaved && $destination !== null && is_file($destination)) {
        @unlink($destination);
    }

    error_log("[PawRescue Photo Upload] " . $e->getMessage());

    reply(500, false, "Unable to upload photo. Please try again.");
}
