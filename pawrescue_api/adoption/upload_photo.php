<?php
// =====================================
// PAWRESCUE COMMUNITY
// PET ADOPTION - UPLOAD ONE PHOTO
// =====================================
// This endpoint receives ONE photo per request.
// The frontend may upload up to 10 photos in sequence.
// CORS / OPTIONS handling remains centralized in .htaccess / cors.php.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// =====================================
// TIMING DIAGNOSTICS
// =====================================
// Open the upload_photo.php request in the browser Network tab.
// Server-Timing separates PHP processing from the overall network time.
// "transaction" includes the file move, SQL work, and transaction commit.
// "filemove" measures only the move_uploaded_file() operation.

$requestStartedAt = microtime(true);
$transactionStartedAt = null;
$transactionFinishedAt = null;
$fileMoveMs = null;

function reply(int $code, array $body): void
{
    global $requestStartedAt;
    global $transactionStartedAt;
    global $transactionFinishedAt;
    global $fileMoveMs;

    $now = microtime(true);
    $totalMs = max(0.0, ($now - $requestStartedAt) * 1000);
    $metrics = ['total;dur=' . number_format($totalMs, 1, '.', '')];

    if ($transactionStartedAt !== null) {
        $finishedAt = $transactionFinishedAt ?? $now;
        $transactionMs = max(0.0, ($finishedAt - $transactionStartedAt) * 1000);
        $metrics[] = 'transaction;dur=' . number_format($transactionMs, 1, '.', '');
    }

    if ($fileMoveMs !== null) {
        $metrics[] = 'filemove;dur=' . number_format($fileMoveMs, 1, '.', '');
    }

    header('Server-Timing: ' . implode(', ', $metrics));
    http_response_code($code);
    echo json_encode($body);
    exit;
}

// PHP can discard the entire $_POST / $_FILES request if post_max_size is
// exceeded. Detect that case before reporting an invalid adoption ID.
function configuredSizeInBytes(string $value): int
{
    $value = trim($value);

    if (!preg_match('/^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i', $value, $matches)) {
        return 0;
    }

    $unit = strtoupper($matches[2]);
    $multipliers = [
        '' => 1,
        'K' => 1024,
        'M' => 1024 * 1024,
        'G' => 1024 * 1024 * 1024
    ];

    return (int) ((float) $matches[1] * $multipliers[$unit]);
}

// =====================================
// REQUEST VALIDATION
// =====================================

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    reply(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

$postMaxBytes = configuredSizeInBytes((string) ini_get('post_max_size'));
$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);

if ($postMaxBytes > 0 && $contentLength > $postMaxBytes) {
    reply(413, [
        'success' => false,
        'message' => 'Upload exceeds the server request-size limit.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
$destination = null;
$fileSaved = false;

try {
    // =====================================
    // AUTHENTICATION: RESIDENT ONLY
    // =====================================

    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $userId = (int) $auth['user']['id'];

    // =====================================
    // ADOPTION ID VALIDATION
    // =====================================

    $adoptionId = filter_var(
        $_POST['adoption_id'] ?? null,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );

    if ($adoptionId === false || $adoptionId === null) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid adoption post ID.'
        ]);
    }

    // =====================================
    // SINGLE PHOTO VALIDATION
    // =====================================

    if (
        !isset($_FILES['photo']) ||
        !is_array($_FILES['photo']) ||
        is_array($_FILES['photo']['error'] ?? null)
    ) {
        reply(400, [
            'success' => false,
            'message' => 'Please choose one photo.'
        ]);
    }

    $file = $_FILES['photo'];
    $uploadError = $file['error'] ?? UPLOAD_ERR_NO_FILE;

    if ($uploadError !== UPLOAD_ERR_OK) {
        $tooLarge = in_array(
            $uploadError,
            [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE],
            true
        );

        reply($tooLarge ? 413 : 400, [
            'success' => false,
            'message' => $tooLarge
                ? 'Photo exceeds the server upload-size limit.'
                : 'Photo upload failed.'
        ]);
    }

    $maxPhotoBytes = 5 * 1024 * 1024;
    $fileSize = (int) ($file['size'] ?? 0);

    if ($fileSize < 1 || $fileSize > $maxPhotoBytes) {
        reply(413, [
            'success' => false,
            'message' => 'Each photo must not exceed 5 MB.'
        ]);
    }

    $tmp = $file['tmp_name'] ?? '';

    if (!is_string($tmp) || !is_uploaded_file($tmp)) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid uploaded file.'
        ]);
    }

    // Do not trust the filename or MIME type supplied by the client.
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($tmp);
    $allowed = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp'
    ];

    if (!isset($allowed[$mime])) {
        reply(400, [
            'success' => false,
            'message' => 'Only JPG, PNG, or WebP photos are allowed.'
        ]);
    }

    $imageInfo = @getimagesize($tmp);

    if (
        !$imageInfo ||
        ($imageInfo['mime'] ?? '') !== $mime ||
        (int) $imageInfo[0] < 1 ||
        (int) $imageInfo[1] < 1 ||
        (int) $imageInfo[0] > 6000 ||
        (int) $imageInfo[1] > 6000
    ) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid photo dimensions or content.'
        ]);
    }

    // =====================================
    // UPLOAD DIRECTORY
    // =====================================

    $root = realpath(dirname(__DIR__));

    if ($root === false || !is_dir($root)) {
        throw new RuntimeException('API project directory not found.');
    }

    $uploadDir = $root
        . DIRECTORY_SEPARATOR . 'uploads'
        . DIRECTORY_SEPARATOR . 'adoptions';

    if (
        !is_dir($uploadDir) &&
        !@mkdir($uploadDir, 0755, true) &&
        !is_dir($uploadDir)
    ) {
        throw new RuntimeException('Unable to create adoption upload directory.');
    }

    if (!is_writable($uploadDir)) {
        throw new RuntimeException('Adoption upload directory is not writable.');
    }

    // =====================================
    // LOCK ADOPTION LISTING
    // =====================================
    // Locking the parent row preserves the 10-photo limit and keeps
    // server-assigned sort_order correct during simultaneous requests.

    $transactionStartedAt = microtime(true);
    $conn->beginTransaction();

    $ownerStmt = $conn->prepare(
        'SELECT id, status
         FROM pet_adoption_posts
         WHERE id = :adoption_id
           AND user_id = :user_id
         LIMIT 1 FOR UPDATE'
    );

    $ownerStmt->execute([
        ':adoption_id' => $adoptionId,
        ':user_id' => $userId
    ]);

    $post = $ownerStmt->fetch(PDO::FETCH_ASSOC);

    if (!$post) {
        $conn->rollBack();
        $transactionFinishedAt = microtime(true);
        reply(404, [
            'success' => false,
            'message' => 'Adoption post not found or access denied.'
        ]);
    }

    if ($post['status'] !== 'available') {
        $conn->rollBack();
        $transactionFinishedAt = microtime(true);
        reply(409, [
            'success' => false,
            'message' => 'Only available adoption posts can be edited.'
        ]);
    }

    $countStmt = $conn->prepare(
        'SELECT COUNT(*)
         FROM pet_adoption_photos
         WHERE adoption_id = :adoption_id'
    );

    $countStmt->execute([':adoption_id' => $adoptionId]);
    $count = (int) $countStmt->fetchColumn();

    if ($count >= 10) {
        $conn->rollBack();
        $transactionFinishedAt = microtime(true);
        reply(409, [
            'success' => false,
            'message' => 'Maximum of 10 photos per adoption post.'
        ]);
    }

    // =====================================
    // MOVE UPLOADED FILE
    // =====================================

    $filename = bin2hex(random_bytes(16)) . '.' . $allowed[$mime];
    $destination = $uploadDir . DIRECTORY_SEPARATOR . $filename;
    $photoPath = '/pawrescue_api/uploads/adoptions/' . $filename;

    $fileMoveStartedAt = microtime(true);
    $saved = move_uploaded_file($tmp, $destination);
    $fileMoveMs = (microtime(true) - $fileMoveStartedAt) * 1000;

    if (!$saved) {
        throw new RuntimeException('Unable to store uploaded photo.');
    }

    $fileSaved = true;

    // =====================================
    // SAVE PHOTO RECORD
    // =====================================

    $insert = $conn->prepare(
        'INSERT INTO pet_adoption_photos
            (adoption_id, photo_path, sort_order)
         VALUES
            (:adoption_id, :photo_path, :sort_order)'
    );

    $insert->execute([
        ':adoption_id' => $adoptionId,
        ':photo_path' => $photoPath,
        ':sort_order' => $count
    ]);

    $photoId = (int) $conn->lastInsertId();
    $conn->commit();
    $transactionFinishedAt = microtime(true);

    // =====================================
    // SUCCESS RESPONSE
    // =====================================
    // Keep the current frontend response keys unchanged.
    // Log unusually slow PHP processing (not the network upload time).

    $processingMs = (microtime(true) - $requestStartedAt) * 1000;
    if ($processingMs >= 2000) {
        error_log(sprintf(
            '[PawRescue Adoption Upload Photo] Slow PHP processing: adoption_id=%d, duration=%.0fms',
            $adoptionId,
            $processingMs
        ));
    }

    reply(201, [
        'success' => true,
        'message' => 'Adoption photo uploaded successfully.',
        'adoption_id' => (int) $adoptionId,
        'photo_id' => $photoId,
        'photo_count' => $count + 1,
        'photo_path' => $photoPath
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    if ($transactionStartedAt !== null && $transactionFinishedAt === null) {
        $transactionFinishedAt = microtime(true);
    }

    // Delete only a photo created by THIS request when the DB save fails.
    if ($fileSaved && $destination !== null && is_file($destination)) {
        @unlink($destination);
    }

    error_log('[PawRescue Adoption Upload Photo] ' . $e->getMessage());

    reply(500, [
        'success' => false,
        'message' => 'Unable to upload adoption photo.'
    ]);
}
