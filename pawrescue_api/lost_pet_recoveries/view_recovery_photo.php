<?php

declare(strict_types=1);

// Warnings and accidental output must never corrupt image bytes.
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');

$recoveryPhotoOriginalBufferLevel = ob_get_level();
ob_start();

header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

function clearRecoveryPhotoOutput(): void
{
    global $recoveryPhotoOriginalBufferLevel;

    while (ob_get_level() > $recoveryPhotoOriginalBufferLevel) {
        $unexpectedOutput = ob_get_contents();
        if (is_string($unexpectedOutput) && $unexpectedOutput !== '') {
            error_log(
                '[PawRescue Lost Recovery Photo View] Discarded unexpected output bytes: '
                . strlen($unexpectedOutput)
            );
        }
        if (!@ob_end_clean()) {
            break;
        }
    }

    // Avoid inherited buffered output prepending text to a binary response.
    if (ob_get_level() > 0 && ob_get_length() > 0) {
        @ob_clean();
    }
}

function sendRecoveryViewError(int $status, string $message, string $code): void
{
    clearRecoveryPhotoOutput();
    http_response_code($status);
    header_remove('Content-Length');
    header('Content-Type: application/json; charset=UTF-8', true);
    header('Cache-Control: private, no-store, max-age=0');

    echo json_encode(
        [
            'success' => false,
            'message' => $message,
            'error_code' => $code
        ],
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function logRecoveryViewError(string $code, int $photoId, string $detail = ''): void
{
    error_log(
        '[PawRescue Lost Recovery Photo View] ' . $code
        . ' | photo_id=' . $photoId
        . ($detail !== '' ? ' | ' . $detail : '')
    );
}

// ============================================================
// 1. REQUIRE GET AND A VALID PHOTO ID
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    sendRecoveryViewError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
}

$photoId = filter_var(
    $_GET['photo_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($photoId === false || $photoId === null) {
    sendRecoveryViewError(400, 'A valid recovery photo ID is required.', 'INVALID_PHOTO_ID');
}
$photoId = (int) $photoId;

try {
    // ========================================================
    // 2. AUTHENTICATE BEFORE ACCESSING PRIVATE PHOTO METADATA
    // ========================================================
    require_once __DIR__ . '/../middleware/auth_middleware.php';

    $auth = authenticate(['resident', 'staff']);
    $conn = $auth['connection'] ?? null;
    $viewer = $auth['user'] ?? null;

    if (!($conn instanceof PDO) || !is_array($viewer)) {
        throw new RuntimeException('Authentication did not return a valid database context.');
    }

    $viewerId = (int) ($viewer['id'] ?? 0);
    $viewerRole = strtolower(trim((string) ($viewer['role'] ?? '')));

    if ($viewerId <= 0 || !in_array($viewerRole, ['resident', 'staff'], true)) {
        sendRecoveryViewError(403, 'Access denied.', 'ACCESS_DENIED');
    }

    // ========================================================
    // 3. LOCATE PHOTO AND VERIFY VIEWER PARTICIPATES IN RECOVERY
    // ========================================================
    $stmt = $conn->prepare(
        'SELECT ph.recovery_id,
                ph.photo_path,
                rec.finder_user_id,
                r.user_id AS owner_user_id
           FROM pet_lost_recovery_photos AS ph
           INNER JOIN pet_lost_recovery_reports AS rec
                   ON rec.id = ph.recovery_id
           INNER JOIN pet_reports AS r
                   ON r.id = rec.lost_report_id
          WHERE ph.id = :photo_id
            AND r.report_type = :report_type
          LIMIT 1'
    );
    $stmt->bindValue(':photo_id', $photoId, PDO::PARAM_INT);
    $stmt->bindValue(':report_type', 'lost', PDO::PARAM_STR);
    $stmt->execute();

    $photo = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!is_array($photo)) {
        sendRecoveryViewError(404, 'Recovery photo not found.', 'PHOTO_NOT_FOUND');
    }

    $canView = $viewerRole === 'staff'
        || $viewerId === (int) $photo['finder_user_id']
        || $viewerId === (int) $photo['owner_user_id'];

    if (!$canView) {
        // Do not disclose private recovery/photo IDs to third parties.
        sendRecoveryViewError(404, 'Recovery photo not found.', 'PHOTO_NOT_FOUND');
    }

    // ========================================================
    // 4. CHECK THE EXACT PATH FORMAT USED BY STEP 52 UPLOAD
    // ========================================================
    $recoveryId = (string) $photo['recovery_id'];
    $relativePath = str_replace('\\', '/', (string) ($photo['photo_path'] ?? ''));

    if (
        preg_match(
            '~\Alost_pet_recoveries/([1-9][0-9]*)/([a-f0-9]{40})\.(jpg|png|webp)\z~D',
            $relativePath,
            $pathParts
        ) !== 1
        || $pathParts[1] !== $recoveryId
    ) {
        logRecoveryViewError('INVALID_STORED_PATH', $photoId, 'recovery_id=' . $recoveryId);
        sendRecoveryViewError(
            422,
            'Recovery photo record has an invalid internal path.',
            'INVALID_STORED_PATH'
        );
    }

    $extension = $pathParts[3];
    $allowedMimes = [
        'jpg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp'
    ];
    $expectedMime = $allowedMimes[$extension];

    // dirname(__DIR__, 4): C:/xampp, from the specified API folder.
    $xamppRoot = dirname(__DIR__, 4);
    $privateRoot = realpath(
        $xamppRoot . DIRECTORY_SEPARATOR . 'pawrescue_private'
    );

    if ($privateRoot === false || !is_dir($privateRoot)) {
        logRecoveryViewError('PRIVATE_STORAGE_MISSING', $photoId);
        sendRecoveryViewError(
            404,
            'Private recovery photo storage is missing on the server.',
            'PRIVATE_STORAGE_MISSING'
        );
    }

    $expectedFolder = realpath(
        $privateRoot . DIRECTORY_SEPARATOR . 'lost_pet_recoveries'
        . DIRECTORY_SEPARATOR . $recoveryId
    );

    if ($expectedFolder === false || !is_dir($expectedFolder)) {
        logRecoveryViewError('RECOVERY_FOLDER_MISSING', $photoId);
        sendRecoveryViewError(
            404,
            'Recovery photo folder is missing on the server.',
            'RECOVERY_FOLDER_MISSING'
        );
    }

    $filePath = realpath(
        $privateRoot . DIRECTORY_SEPARATOR
        . str_replace('/', DIRECTORY_SEPARATOR, $relativePath)
    );

    if ($filePath === false || !is_file($filePath)) {
        logRecoveryViewError('PHOTO_FILE_MISSING', $photoId, 'recovery_id=' . $recoveryId);
        sendRecoveryViewError(
            404,
            'Recovery photo file is missing on the server.',
            'PHOTO_FILE_MISSING'
        );
    }

    // Prevent symlink traversal or an unexpected file location.
    $expectedFilePrefix = rtrim($expectedFolder, '\\/') . DIRECTORY_SEPARATOR;
    $isInsideFolder = PHP_OS_FAMILY === 'Windows'
        ? strncasecmp($filePath, $expectedFilePrefix, strlen($expectedFilePrefix)) === 0
        : strncmp($filePath, $expectedFilePrefix, strlen($expectedFilePrefix)) === 0;

    $privatePrefix = rtrim($privateRoot, '\\/') . DIRECTORY_SEPARATOR;
    $folderInsideStorage = PHP_OS_FAMILY === 'Windows'
        ? strncasecmp($expectedFolder, $privatePrefix, strlen($privatePrefix)) === 0
        : strncmp($expectedFolder, $privatePrefix, strlen($privatePrefix)) === 0;

    if (!$isInsideFolder || !$folderInsideStorage) {
        logRecoveryViewError('UNSAFE_PHOTO_PATH', $photoId);
        sendRecoveryViewError(404, 'Recovery photo not found.', 'PHOTO_NOT_FOUND');
    }

    if (!is_readable($filePath)) {
        logRecoveryViewError('PHOTO_NOT_READABLE', $photoId);
        sendRecoveryViewError(
            500,
            'Server cannot read this recovery photo.',
            'PHOTO_NOT_READABLE'
        );
    }

    // ========================================================
    // 5. READ AND VALIDATE THE ACTUAL IMAGE BEFORE SENDING HEADERS
    // ========================================================
    $maxBytes = 5 * 1024 * 1024;
    $fileSize = @filesize($filePath);

    if (!is_int($fileSize) || $fileSize < 1 || $fileSize > $maxBytes) {
        logRecoveryViewError('INVALID_PHOTO_SIZE', $photoId);
        sendRecoveryViewError(422, 'Recovery photo has an invalid size.', 'INVALID_PHOTO_SIZE');
    }

    $imageBytes = @file_get_contents($filePath);
    if (!is_string($imageBytes) || strlen($imageBytes) !== $fileSize) {
        logRecoveryViewError('PHOTO_READ_FAILED', $photoId);
        sendRecoveryViewError(500, 'Unable to read recovery photo.', 'PHOTO_READ_FAILED');
    }

    $mime = (new finfo(FILEINFO_MIME_TYPE))->buffer($imageBytes);
    $imageInfo = @getimagesizefromstring($imageBytes);

    if (
        $mime !== $expectedMime
        || !is_array($imageInfo)
        || ($imageInfo['mime'] ?? '') !== $expectedMime
        || (int) ($imageInfo[0] ?? 0) < 1
        || (int) ($imageInfo[1] ?? 0) < 1
        || (int) ($imageInfo[0] ?? 0) > 5000
        || (int) ($imageInfo[1] ?? 0) > 5000
    ) {
        logRecoveryViewError(
            'INVALID_IMAGE_DATA',
            $photoId,
            'expected=' . $expectedMime . ', detected=' . (string) $mime
        );
        sendRecoveryViewError(
            422,
            'Recovery photo file is not a valid image of its recorded type.',
            'INVALID_IMAGE_DATA'
        );
    }

    // ========================================================
    // 6. SEND ONLY BINARY IMAGE DATA (NO PHP WARNINGS OR JSON)
    // ========================================================
    clearRecoveryPhotoOutput();
    header_remove('Content-Type');
    header_remove('Content-Length');

    http_response_code(200);
    header('Content-Type: ' . $expectedMime);
    header('Content-Length: ' . strlen($imageBytes));
    header('Content-Disposition: inline; filename="lost-pet-recovery-evidence.' . $extension . '"');
    header('Cache-Control: private, no-store, max-age=0');
    header('X-Content-Type-Options: nosniff');

    echo $imageBytes;
    exit;
} catch (Throwable $e) {
    logRecoveryViewError('UNEXPECTED_ERROR', $photoId, $e->getMessage());
    sendRecoveryViewError(
        500,
        'Unable to view the Lost Pet recovery evidence photo.',
        'PHOTO_SERVER_ERROR'
    );
}
