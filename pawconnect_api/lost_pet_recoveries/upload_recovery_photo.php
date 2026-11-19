<?php
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendRecoveryPhotoResponse(int $httpStatus, array $data): void
{
    http_response_code($httpStatus);
    echo json_encode(
        $data,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function rejectRecoveryPhoto(PDO $conn, int $httpStatus, string $message, array $extra = []): void
{
    if ($conn->inTransaction()) {
        $conn->rollBack();
    }

    sendRecoveryPhotoResponse($httpStatus, array_merge([
        'success' => false,
        'message' => $message
    ], $extra));
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRecoveryPhotoResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'multipart/form-data') === false) {
    sendRecoveryPhotoResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be multipart/form-data.'
    ]);
}

$maxPhotoBytes = 5 * 1024 * 1024;

if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $maxPhotoBytes + 1024 * 1024) {
    sendRecoveryPhotoResponse(413, [
        'success' => false,
        'message' => 'The selected photo exceeds the 5 MB limit.'
    ]);
}

$recoveryId = filter_var(
    $_POST['recovery_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($recoveryId === false || $recoveryId === null) {
    sendRecoveryPhotoResponse(400, [
        'success' => false,
        'message' => 'A valid Lost Pet recovery ID is required.'
    ]);
}

if (
    !isset($_FILES['photo']) ||
    !is_array($_FILES['photo']) ||
    is_array($_FILES['photo']['name'] ?? null) ||
    is_array($_FILES['photo']['tmp_name'] ?? null)
) {
    sendRecoveryPhotoResponse(400, [
        'success' => false,
        'message' => 'Select one photo to upload.'
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

    sendRecoveryPhotoResponse($tooLarge ? 413 : 400, [
        'success' => false,
        'message' => $tooLarge
            ? 'The image exceeds the server upload limit.'
            : 'The photo could not be received. Please try again.'
    ]);
}

$tmpPath = $file['tmp_name'] ?? null;
$size = $file['size'] ?? null;
if (
    !is_string($tmpPath) ||
    !is_uploaded_file($tmpPath) ||
    !is_numeric($size) ||
    (int) $size < 1 ||
    (int) $size > $maxPhotoBytes
) {
    sendRecoveryPhotoResponse(400, [
        'success' => false,
        'message' => 'The photo is invalid or exceeds 5 MB.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
$savedPath = null;

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $finderId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $finderId <= 0) {
        throw new RuntimeException('Invalid authenticated resident context.');
    }

    $mimeToExtension = [
        'image/jpeg' => 'jpg',
        'image/png'  => 'png',
        'image/webp' => 'webp'
    ];

    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($tmpPath);
    $imageInfo = @getimagesize($tmpPath);

    if (
        !is_string($mime) ||
        !isset($mimeToExtension[$mime]) ||
        !is_array($imageInfo) ||
        ($imageInfo['mime'] ?? null) !== $mime
    ) {
        sendRecoveryPhotoResponse(400, [
            'success' => false,
            'message' => 'Please upload a valid JPG, PNG, or WebP photo.'
        ]);
    }

    $width = (int) ($imageInfo[0] ?? 0);
    $height = (int) ($imageInfo[1] ?? 0);
    if ($width < 1 || $height < 1 || $width > 5000 || $height > 5000) {
        sendRecoveryPhotoResponse(400, [
            'success' => false,
            'message' => 'Photo dimensions must be 1 to 5000 pixels on each side.'
        ]);
    }

    $conn->beginTransaction();

    $idStmt = $conn->prepare(
        'SELECT lost_report_id
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id
         LIMIT 1'
    );
    $idStmt->execute([':recovery_id' => $recoveryId]);
    $lostReportId = $idStmt->fetchColumn();

    if ($lostReportId === false) {
        rejectRecoveryPhoto($conn, 404, 'Recovery report not found or access denied.');
    }

    $reportStmt = $conn->prepare(
        'SELECT id, report_type, status, deleted_at
         FROM pet_reports
         WHERE id = :lost_report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':lost_report_id' => $lostReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    $recoveryStmt = $conn->prepare(
        'SELECT id, lost_report_id, finder_user_id, status
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id
         LIMIT 1 FOR UPDATE'
    );
    $recoveryStmt->execute([':recovery_id' => $recoveryId]);
    $recovery = $recoveryStmt->fetch(PDO::FETCH_ASSOC);

    if (
        !$report || !$recovery ||
        (string) $recovery['lost_report_id'] !== (string) $report['id'] ||
        (int) $recovery['finder_user_id'] !== $finderId
    ) {
        rejectRecoveryPhoto($conn, 404, 'Recovery report not found or access denied.');
    }

    // Archived reports remain available for historical evidence viewing,
    // but must never accept new recovery evidence uploads.
    if ($report['deleted_at'] !== null) {
        rejectRecoveryPhoto($conn, 409, 'This Lost Pet report is archived. New recovery photos cannot be uploaded.');
    }

    if (
        $report['report_type'] !== 'lost' ||
        !in_array(
            (string) $report['status'],
            ['pending', 'under_review', 'in_progress'],
            true
        ) ||
        $recovery['status'] !== 'pending'
    ) {
        rejectRecoveryPhoto(
            $conn,
            409,
            'Evidence photos may only be added to a pending recovery for an active Lost Pet report.'
        );
    }

    $photosStmt = $conn->prepare(
        'SELECT id
         FROM pet_lost_recovery_photos
         WHERE recovery_id = :recovery_id
         ORDER BY id
         FOR UPDATE'
    );
    $photosStmt->execute([':recovery_id' => $recoveryId]);
    $existingCount = count($photosStmt->fetchAll(PDO::FETCH_COLUMN));

    if ($existingCount >= 5) {
        rejectRecoveryPhoto($conn, 409, 'Maximum of five recovery photos reached.', [
            'recovery_id' => (int) $recoveryId,
            'photo_count' => $existingCount,
            'max_photos' => 5
        ]);
    }

    $xamppRoot = dirname(__DIR__, 4);
    $privateRoot = $xamppRoot . DIRECTORY_SEPARATOR . 'pawrescue_private';
    $recoveryRoot = $privateRoot . DIRECTORY_SEPARATOR . 'lost_pet_recoveries';
    $recoveryFolder = $recoveryRoot . DIRECTORY_SEPARATOR . (string) $recoveryId;

    foreach ([$privateRoot, $recoveryRoot, $recoveryFolder] as $directory) {
        if (!is_dir($directory)) {
            if (!@mkdir($directory, 0700) && !is_dir($directory)) {
                throw new RuntimeException('Cannot create private recovery photo directory.');
            }
        }
    }

    $realPrivateRoot = realpath($privateRoot);
    $realRecoveryFolder = realpath($recoveryFolder);
    $realXamppRoot = realpath($xamppRoot);
    if (
        $realPrivateRoot === false ||
        $realRecoveryFolder === false ||
        $realXamppRoot === false ||
        dirname($realPrivateRoot) !== $realXamppRoot ||
        strncmp(
            $realRecoveryFolder,
            rtrim($realPrivateRoot, '\\/') . DIRECTORY_SEPARATOR,
            strlen(rtrim($realPrivateRoot, '\\/') . DIRECTORY_SEPARATOR)
        ) !== 0 ||
        !is_writable($realRecoveryFolder)
    ) {
        throw new RuntimeException('Private evidence directory failed security validation.');
    }

    $extension = $mimeToExtension[$mime];
    $filename = bin2hex(random_bytes(20)) . '.' . $extension;
    $savedPath = $realRecoveryFolder . DIRECTORY_SEPARATOR . $filename;

    if (!move_uploaded_file($tmpPath, $savedPath)) {
        $savedPath = null;
        throw new RuntimeException('Unable to store private recovery evidence photo.');
    }
    @chmod($savedPath, 0640);

    $relativePath = 'lost_pet_recoveries/' . $recoveryId . '/' . $filename;

    $insertStmt = $conn->prepare(
        'INSERT INTO pet_lost_recovery_photos
         (recovery_id, photo_path, sort_order)
         VALUES (:recovery_id, :photo_path, :sort_order)'
    );
    $insertStmt->execute([
        ':recovery_id' => $recoveryId,
        ':photo_path' => $relativePath,
        ':sort_order' => $existingCount
    ]);

    $photoId = (int) $conn->lastInsertId();
    if ($photoId <= 0) {
        throw new RuntimeException('New photo ID was not returned.');
    }

    $conn->commit();
    $savedPath = null;

    sendRecoveryPhotoResponse(201, [
        'success' => true,
        'message' => 'Private Lost Pet recovery photo uploaded successfully.',
        'recovery_id' => (int) $recoveryId,
        'photo_id' => $photoId,
        'photo_count' => $existingCount + 1,
        'max_photos' => 5
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    if ($savedPath !== null && is_file($savedPath)) {
        @unlink($savedPath);
    }

    error_log('[PawConnect Lost Recovery Photo Upload] ' . $e->getMessage());
    sendRecoveryPhotoResponse(500, [
        'success' => false,
        'message' => 'Unable to upload private Lost Pet recovery photo.'
    ]);
}
