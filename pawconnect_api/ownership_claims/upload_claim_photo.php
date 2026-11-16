<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendClaimPhotoResponse(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

// =====================================================
// METHOD AND UPLOAD TYPE
// =====================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendClaimPhotoResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'multipart/form-data') === false) {
    sendClaimPhotoResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be multipart/form-data.'
    ]);
}

// Prevent requests greatly exceeding the single-image upload limit.
// Keep PHP upload_max_filesize/post_max_size configured to >= 6M.
$maxBytes = 5 * 1024 * 1024;
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $maxBytes + (1024 * 1024)) {
    sendClaimPhotoResponse(413, [
        'success' => false,
        'message' => 'The image exceeds the 5 MB upload limit.'
    ]);
}

$claimId = filter_var(
    $_POST['claim_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($claimId === false || $claimId === null) {
    sendClaimPhotoResponse(400, [
        'success' => false,
        'message' => 'A valid ownership claim ID is required.'
    ]);
}

if (
    !isset($_FILES['photo']) ||
    !is_array($_FILES['photo']) ||
    is_array($_FILES['photo']['name'] ?? null)
) {
    sendClaimPhotoResponse(400, [
        'success' => false,
        'message' => 'Please select one photo to upload.'
    ]);
}

$file = $_FILES['photo'];
$uploadError = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);

if ($uploadError !== UPLOAD_ERR_OK) {
    $tooLarge = in_array(
        $uploadError,
        [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE],
        true
    );

    sendClaimPhotoResponse($tooLarge ? 413 : 400, [
        'success' => false,
        'message' => $tooLarge
            ? 'The image exceeds the server upload limit.'
            : 'Unable to receive the selected photo.'
    ]);
}

$tmpPath = $file['tmp_name'] ?? null;
$fileSize = $file['size'] ?? null;

if (
    !is_string($tmpPath) ||
    !is_uploaded_file($tmpPath) ||
    !is_numeric($fileSize) ||
    (int) $fileSize <= 0 ||
    (int) $fileSize > $maxBytes
) {
    sendClaimPhotoResponse(400, [
        'success' => false,
        'message' => 'The photo is invalid or exceeds 5 MB.'
    ]);
}

// Validate actual file content, not the user-supplied extension.
$allowedMimeTypes = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp'
];

$finfo = new finfo(FILEINFO_MIME_TYPE);
$detectedMime = $finfo->file($tmpPath);
$imageInfo = @getimagesize($tmpPath);

if (
    !is_string($detectedMime) ||
    !isset($allowedMimeTypes[$detectedMime]) ||
    !is_array($imageInfo) ||
    ($imageInfo['mime'] ?? null) !== $detectedMime
) {
    sendClaimPhotoResponse(400, [
        'success' => false,
        'message' => 'Only valid JPG, PNG, and WebP images are accepted.'
    ]);
}

$width = (int) ($imageInfo[0] ?? 0);
$height = (int) ($imageInfo[1] ?? 0);
if ($width < 1 || $height < 1 || $width > 5000 || $height > 5000) {
    sendClaimPhotoResponse(400, [
        'success' => false,
        'message' => 'Photo dimensions must be between 1 and 5000 pixels per side.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
$savedPath = null;

try {
    // =====================================================
    // AUTHENTICATE RESIDENT B
    // =====================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $claimantId = (int) $auth['user']['id'];

    if (!($conn instanceof PDO) || $claimantId <= 0) {
        throw new RuntimeException('Invalid authenticated session context.');
    }

    $conn->beginTransaction();

    // =====================================================
    // CHECK OWNERSHIP, CLAIM STATUS AND FOUND REPORT STATUS
    // =====================================================
    // Lock the claim (and the joined report) so concurrent uploads
    // cannot both pass the five-photo limit. Claim decision APIs
    // should also lock this claim row before modifying its status.
    $claimStmt = $conn->prepare(
        'SELECT c.id,
                c.status AS claim_status,
                p.report_type,
                p.status AS report_status
         FROM pet_ownership_claims c
         INNER JOIN pet_reports p ON p.id = c.found_report_id
         WHERE c.id = :claim_id
           AND c.claimant_user_id = :claimant_id
         LIMIT 1
         FOR UPDATE'
    );

    $claimStmt->execute([
        ':claim_id' => $claimId,
        ':claimant_id' => $claimantId
    ]);
    $claim = $claimStmt->fetch(PDO::FETCH_ASSOC);

    if (!$claim) {
        $conn->rollBack();
        sendClaimPhotoResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found or access denied.'
        ]);
    }

    if (
        $claim['claim_status'] !== 'pending' ||
        $claim['report_type'] !== 'found' ||
        !in_array(
            (string) $claim['report_status'],
            ['pending', 'under_review', 'in_progress'],
            true
        )
    ) {
        $conn->rollBack();
        sendClaimPhotoResponse(409, [
            'success' => false,
            'message' => 'Photos may only be added while a Found Pet claim is pending.'
        ]);
    }

    $countStmt = $conn->prepare(
        'SELECT COUNT(*) FROM pet_ownership_claim_photos
         WHERE claim_id = :claim_id'
    );
    $countStmt->execute([':claim_id' => $claimId]);
    $photoCount = (int) $countStmt->fetchColumn();

    if ($photoCount >= 5) {
        $conn->rollBack();
        sendClaimPhotoResponse(409, [
            'success' => false,
            'message' => 'A claim can contain a maximum of 5 evidence photos.',
            'photo_count' => $photoCount,
            'max_photos' => 5
        ]);
    }

    // =====================================================
    // STORE FILE OUTSIDE THE PUBLIC WEB DOCUMENT ROOT
    // =====================================================
    // Given C:/xampp/htdocs/pawrescue/pawrescue_api/ownership_claims,
    // dirname(__DIR__, 4) resolves to C:/xampp (not htdocs).
    $xamppRoot = dirname(__DIR__, 4);
    $privateRoot = $xamppRoot . DIRECTORY_SEPARATOR . 'pawrescue_private';
    $evidenceRoot = $privateRoot . DIRECTORY_SEPARATOR . 'ownership_claims';
    $claimFolder = $evidenceRoot . DIRECTORY_SEPARATOR . (string) $claimId;

    foreach ([$privateRoot, $evidenceRoot, $claimFolder] as $directory) {
        if (!is_dir($directory)) {
            if (!@mkdir($directory, 0700) && !is_dir($directory)) {
                throw new RuntimeException('Unable to create private photo storage.');
            }
        }
    }

    if (!is_writable($claimFolder)) {
        throw new RuntimeException('Private photo storage is not writable.');
    }

    $extension = $allowedMimeTypes[$detectedMime];
    $filename = bin2hex(random_bytes(20)) . '.' . $extension;
    $savedPath = $claimFolder . DIRECTORY_SEPARATOR . $filename;

    if (!move_uploaded_file($tmpPath, $savedPath)) {
        $savedPath = null;
        throw new RuntimeException('Unable to save the private evidence photo.');
    }

    @chmod($savedPath, 0640);

    // Save a RELATIVE internal path, never a public URL.
    $relativePath = 'ownership_claims/' . $claimId . '/' . $filename;

    $insertStmt = $conn->prepare(
        'INSERT INTO pet_ownership_claim_photos
         (claim_id, photo_path, sort_order)
         VALUES (:claim_id, :photo_path, :sort_order)'
    );
    $insertStmt->execute([
        ':claim_id' => $claimId,
        ':photo_path' => $relativePath,
        ':sort_order' => $photoCount
    ]);

    $photoId = (int) $conn->lastInsertId();
    $conn->commit();
    $savedPath = null;

    sendClaimPhotoResponse(201, [
        'success' => true,
        'message' => 'Private ownership evidence photo uploaded.',
        'claim_id' => (int) $claimId,
        'photo_id' => $photoId,
        'photo_count' => $photoCount + 1,
        'max_photos' => 5
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    if ($savedPath !== null && is_file($savedPath)) {
        @unlink($savedPath);
    }

    error_log('[PawRescue Ownership Evidence Upload] ' . $e->getMessage());
    sendClaimPhotoResponse(500, [
        'success' => false,
        'message' => 'Unable to upload ownership evidence photo.'
    ]);
}
