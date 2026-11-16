<?php

// =====================================
// PAWRESCUE COMMUNITY
// DELETE ONE PET REPORT PHOTO
// =====================================

// CORS is handled by cors.php through .htaccess.
header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

function sendDeletePhotoResponse(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST, OPTIONS");
    sendDeletePhotoResponse(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

if (stripos($_SERVER["CONTENT_TYPE"] ?? "", "application/json") === false) {
    sendDeletePhotoResponse(415, [
        "success" => false,
        "message" => "Content-Type must be application/json."
    ]);
}

require_once __DIR__ . "/../middleware/auth_middleware.php";

$conn = null;

try {
    $auth = authenticate(["resident"]);
    $conn = $auth["connection"];
    $userId = (int) $auth["user"]["id"];

    $input = json_decode(file_get_contents("php://input"), true);
    if (!is_array($input) || array_is_list($input)) {
        sendDeletePhotoResponse(400, [
            "success" => false,
            "message" => "Invalid JSON request."
        ]);
    }

    $reportId = filter_var($input["report_id"] ?? null, FILTER_VALIDATE_INT, [
        "options" => ["min_range" => 1]
    ]);
    $photoId = filter_var($input["photo_id"] ?? null, FILTER_VALIDATE_INT, [
        "options" => ["min_range" => 1]
    ]);

    if ($reportId === false || $photoId === false ||
        $reportId === null || $photoId === null) {
        sendDeletePhotoResponse(400, [
            "success" => false,
            "message" => "Invalid report or photo ID."
        ]);
    }

    // Lock the parent report first. The upload endpoint
    // locks the same row, so upload/delete remain serialized.
    $conn->beginTransaction();

    $reportStmt = $conn->prepare(
        "SELECT id, status
         FROM pet_reports
         WHERE id = :report_id
           AND user_id = :user_id
           AND report_type IN ('lost', 'found')
         LIMIT 1 FOR UPDATE"
    );
    $reportStmt->execute([
        ":report_id" => $reportId,
        ":user_id" => $userId
    ]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (!$report) {
        $conn->rollBack();
        sendDeletePhotoResponse(404, [
            "success" => false,
            "message" => "Report not found or access denied."
        ]);
    }

    if (!in_array($report["status"], ["pending", "under_review", "in_progress"], true)) {
        $conn->rollBack();
        sendDeletePhotoResponse(409, [
            "success" => false,
            "message" => "Photos cannot be deleted from resolved or closed reports."
        ]);
    }

    $photoStmt = $conn->prepare(
        "SELECT id, photo_path
         FROM pet_report_photos
         WHERE id = :photo_id AND report_id = :report_id
         LIMIT 1 FOR UPDATE"
    );
    $photoStmt->execute([
        ":photo_id" => $photoId,
        ":report_id" => $reportId
    ]);
    $photo = $photoStmt->fetch(PDO::FETCH_ASSOC);

    if (!$photo) {
        $conn->rollBack();
        sendDeletePhotoResponse(404, [
            "success" => false,
            "message" => "Photo not found in this report."
        ]);
    }

    $deleteStmt = $conn->prepare(
        "DELETE FROM pet_report_photos
         WHERE id = :photo_id AND report_id = :report_id"
    );
    $deleteStmt->execute([
        ":photo_id" => $photoId,
        ":report_id" => $reportId
    ]);

    if ($deleteStmt->rowCount() !== 1) {
        throw new RuntimeException("Unable to delete photo record.");
    }

    // Reindex order. This also keeps the next upload's
    // sort_order aligned with the current photo count.
    $remainingStmt = $conn->prepare(
        "SELECT id, photo_path
         FROM pet_report_photos
         WHERE report_id = :report_id
         ORDER BY sort_order ASC, id ASC"
    );
    $remainingStmt->execute([":report_id" => $reportId]);
    $remaining = $remainingStmt->fetchAll(PDO::FETCH_ASSOC);

    $reorder = $conn->prepare(
        "UPDATE pet_report_photos SET sort_order = :sort_order
         WHERE id = :id AND report_id = :report_id"
    );
    foreach ($remaining as $position => $item) {
        $reorder->execute([
            ":sort_order" => $position,
            ":id" => $item["id"],
            ":report_id" => $reportId
        ]);
    }

    $primaryPhotoPath = !empty($remaining) ? $remaining[0]["photo_path"] : null;

    // Keep the legacy image column synchronized.
    $updateParent = $conn->prepare(
        "UPDATE pet_reports
         SET photo_path = :photo_path
         WHERE id = :report_id AND user_id = :user_id"
    );
    $updateParent->execute([
        ":photo_path" => $primaryPhotoPath,
        ":report_id" => $reportId,
        ":user_id" => $userId
    ]);

    $conn->commit();

    // File removal is after the database commit. Never use
    // a user-supplied filename or an unchecked filesystem path.
    $storedPath = (string) $photo["photo_path"];
    $prefixes = [
        "/pawrescue_api/uploads/pets/",
        "/pawrescue/pawrescue_api/uploads/pets/"
    ];

    $fileName = null;
    foreach ($prefixes as $prefix) {
        if (str_starts_with($storedPath, $prefix)) {
            $candidate = substr($storedPath, strlen($prefix));
            if (preg_match('/^[a-f0-9]{32}\.(jpg|png|webp)$/', $candidate)) {
                $fileName = $candidate;
            }
            break;
        }
    }

    if ($fileName !== null) {
        // Avoid removing a file that another photo record references.
        $checkRefs = $conn->prepare(
            "SELECT COUNT(*) FROM pet_report_photos WHERE photo_path = :photo_path"
        );
        $checkRefs->execute([":photo_path" => $storedPath]);
        if ((int) $checkRefs->fetchColumn() === 0) {
            $filePath = dirname(__DIR__) . "/uploads/pets/" . $fileName;
            if (is_file($filePath) && !@unlink($filePath)) {
                error_log("[PawRescue Delete Photo] Unable to remove orphan file: " . $fileName);
            }
        }
    }

    sendDeletePhotoResponse(200, [
        "success" => true,
        "message" => "Photo deleted successfully.",
        "report_id" => (int) $reportId,
        "deleted_photo_id" => (int) $photoId,
        "photo_count" => count($remaining),
        "primary_photo_path" => $primaryPhotoPath
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    error_log("[PawRescue Delete Photo] " . $e->getMessage());
    sendDeletePhotoResponse(500, [
        "success" => false,
        "message" => "Unable to delete photo. Please try again."
    ]);
}
