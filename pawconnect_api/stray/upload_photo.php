<?php

// =====================================
// PAWRESCUE COMMUNITY
// STRAY ANIMAL ASSISTANCE - PHOTO UPLOAD
// Save as: pawrescue_api/stray/upload_photo.php
// =====================================

// Centralized CORS is handled by the existing
// pawrescue_api/.htaccess and cors.php setup.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function strayPhotoResponse(int $status, bool $success, string $message, array $extra = []): void
{
    http_response_code($status);
    echo json_encode(array_merge([
        'success' => $success,
        'message' => $message,
    ], $extra));
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    strayPhotoResponse(405, false, 'Method not allowed.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

// The file is removed if saving its database entry fails.
$destination = null;
$fileSaved = false;
$conn = null;

try {
    // Only the signed-in resident who owns the report
    // may add photos to that report.
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $userId = (int) $auth['user']['id'];

    // Expect multipart/form-data containing report_id and photo.
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (stripos($contentType, 'multipart/form-data') === false) {
        strayPhotoResponse(415, false, 'Content-Type must be multipart/form-data.');
    }

    $reportId = filter_var(
        $_POST['report_id'] ?? null,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );

    if ($reportId === false || $reportId === null) {
        strayPhotoResponse(400, false, 'Invalid stray report ID.');
    }

    // Upload one photo per request, matching report-stray.page.ts.
    if (
        !isset($_FILES['photo']) ||
        !is_array($_FILES['photo']) ||
        is_array($_FILES['photo']['error'] ?? null)
    ) {
        strayPhotoResponse(400, false, 'Please select a photo.');
    }

    $file = $_FILES['photo'];
    $uploadError = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);

    if ($uploadError !== UPLOAD_ERR_OK) {
        if (in_array($uploadError, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
            strayPhotoResponse(413, false, 'Uploaded photo is too large.');
        }
        strayPhotoResponse(400, false, 'Photo upload failed.');
    }

    // Frontend permits at most 5 MB per photo.
    $maxBytes = 5 * 1024 * 1024;
    $size = (int) ($file['size'] ?? 0);
    if ($size < 1 || $size > $maxBytes) {
        strayPhotoResponse(413, false, 'Photo must be 5 MB or smaller.');
    }

    $tmpPath = $file['tmp_name'] ?? null;
    if (!is_string($tmpPath) || !is_uploaded_file($tmpPath)) {
        strayPhotoResponse(400, false, 'Invalid uploaded file.');
    }

    // Verify actual file content, not the browser-provided filename.
    $allowedMimeTypes = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
    ];

    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($tmpPath);
    if (!is_string($mime) || !isset($allowedMimeTypes[$mime])) {
        strayPhotoResponse(400, false, 'Only JPG, PNG and WebP images are supported.');
    }

    $imageInfo = @getimagesize($tmpPath);
    if (
        $imageInfo === false ||
        ($imageInfo['mime'] ?? null) !== $mime ||
        (int) $imageInfo[0] < 1 ||
        (int) $imageInfo[1] < 1 ||
        (int) $imageInfo[0] > 6000 ||
        (int) $imageInfo[1] > 6000
    ) {
        strayPhotoResponse(400, false, 'Invalid image content or dimensions.');
    }

    // Save separately from Lost & Found and Pet Adoption photos.
    $apiRoot = realpath(dirname(__DIR__));
    if ($apiRoot === false) {
        throw new RuntimeException('API directory was not found.');
    }

    $uploadsRoot = $apiRoot . DIRECTORY_SEPARATOR . 'uploads';
    $uploadDirectory = $uploadsRoot . DIRECTORY_SEPARATOR . 'strays';

    if (!is_dir($uploadDirectory) && !@mkdir($uploadDirectory, 0755, true) && !is_dir($uploadDirectory)) {
        throw new RuntimeException('Unable to create stray photo directory.');
    }
    if (!is_writable($uploadDirectory)) {
        throw new RuntimeException('Stray photo directory is not writable.');
    }

    $filename = bin2hex(random_bytes(16)) . '.' . $allowedMimeTypes[$mime];
    $destination = $uploadDirectory . DIRECTORY_SEPARATOR . $filename;

    // Same legacy URL-path format used by the Lost & Found upload API.
    // Frontend display pages should normalize the path under /pawrescue.
    $photoPath = '/pawrescue_api/uploads/strays/' . $filename;

    // Lock the parent report so concurrent uploads cannot exceed 10.
    $conn->beginTransaction();

    $find = $conn->prepare(
        'SELECT id, status
         FROM stray_reports
         WHERE id = :report_id AND user_id = :user_id
         LIMIT 1 FOR UPDATE'
    );
    $find->execute([
        ':report_id' => $reportId,
        ':user_id' => $userId,
    ]);
    $report = $find->fetch(PDO::FETCH_ASSOC);

    if (!$report) {
        $conn->rollBack();
        strayPhotoResponse(404, false, 'Stray report not found or access denied.');
    }

    if (!in_array($report['status'], ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        strayPhotoResponse(409, false, 'Photos cannot be added to resolved or rejected reports.');
    }

    $count = $conn->prepare(
        'SELECT COUNT(*)
         FROM stray_report_photos
         WHERE stray_report_id = :report_id'
    );
    $count->execute([':report_id' => $reportId]);
    $photoCount = (int) $count->fetchColumn();
    $maxPhotos = 10;

    if ($photoCount >= $maxPhotos) {
        $conn->rollBack();
        strayPhotoResponse(409, false, 'A stray report can contain a maximum of 10 photos.', [
            'photo_count' => $photoCount,
            'max_photos' => $maxPhotos,
        ]);
    }

    if (!move_uploaded_file($tmpPath, $destination)) {
        throw new RuntimeException('Unable to save the uploaded photo.');
    }
    $fileSaved = true;

    // Note: stray_report_photos uses stray_report_id (not report_id).
    $insert = $conn->prepare(
        'INSERT INTO stray_report_photos
            (stray_report_id, photo_path, sort_order)
         VALUES (:stray_report_id, :photo_path, :sort_order)'
    );
    $insert->execute([
        ':stray_report_id' => $reportId,
        ':photo_path' => $photoPath,
        ':sort_order' => $photoCount,
    ]);

    $photoId = (int) $conn->lastInsertId();
    $conn->commit();

    strayPhotoResponse(200, true, 'Stray animal photo uploaded successfully!', [
        'report_id' => (int) $reportId,
        'photo_id' => $photoId,
        'photo_path' => $photoPath,
        'photo_count' => $photoCount + 1,
        'max_photos' => $maxPhotos,
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    if ($fileSaved && $destination !== null && is_file($destination)) {
        @unlink($destination);
    }

    error_log('[PawRescue Stray Photo Upload] ' . $e->getMessage());
    strayPhotoResponse(500, false, 'Unable to upload stray photo. Please try again.');
}
