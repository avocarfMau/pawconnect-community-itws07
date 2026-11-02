<?php


declare(strict_types=1);

// Do not let PHP warnings/notices prepend text to image data.
// The warning itself will still be written to the PHP/Apache log.
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');

// Capture accidental output from required PHP files. This is
// particularly important when returning an image as a Blob.
$photoBufferBaseline = ob_get_level();
ob_start();

header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

function clearPrivatePhotoOutput(): void
{
    global $photoBufferBaseline;

    // Discard everything written by this endpoint or its includes.
    while (ob_get_level() > $photoBufferBaseline) {
        $buffer = ob_get_contents();
        if (is_string($buffer) && $buffer !== '') {
            error_log(
                '[PawRescue View Ownership Evidence] Discarded '
                . strlen($buffer) . ' unexpected output bytes before response.'
            );
        }
        if (!@ob_end_clean()) {
            break;
        }
    }

    // Some XAMPP installations enable an outer PHP output buffer.
    // A binary-only endpoint must not contain previously echoed text.
    if (ob_get_level() > 0 && ob_get_length() > 0) {
        @ob_clean();
    }
}

function privatePhotoError(
    int $httpStatus,
    string $message,
    string $errorCode
): void {
    clearPrivatePhotoOutput();
    http_response_code($httpStatus);
    header_remove('Content-Length');
    header('Content-Type: application/json; charset=UTF-8', true);
    header('Cache-Control: private, no-store, max-age=0');

    echo json_encode(
        [
            'success' => false,
            'message' => $message,
            'error_code' => $errorCode
        ],
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function privatePhotoLog(string $code, int $photoId, string $detail = ''): void
{
    error_log(
        '[PawRescue View Ownership Evidence] ' . $code
        . ' | photo_id=' . $photoId
        . ($detail !== '' ? ' | ' . $detail : '')
    );
}

// =============================================================
// REQUIRE AN AUTHENTICATED GET REQUEST
// =============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    privatePhotoError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
}

$photoId = filter_var(
    $_GET['photo_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($photoId === false || $photoId === null) {
    privatePhotoError(400, 'A valid evidence photo ID is required.', 'INVALID_PHOTO_ID');
}
$photoId = (int) $photoId;

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // =========================================================
    // AUTHENTICATION: DO NOT ACCEPT A USER ID FROM THE CLIENT
    // =========================================================
    $auth = authenticate(['resident', 'staff']);
    $conn = $auth['connection'] ?? null;
    $viewer = $auth['user'] ?? null;

    if (!($conn instanceof PDO) || !is_array($viewer)) {
        throw new RuntimeException('Authenticated session returned invalid context.');
    }

    $viewerId = (int) ($viewer['id'] ?? 0);
    $viewerRole = strtolower(trim((string) ($viewer['role'] ?? '')));

    if ($viewerId <= 0 || !in_array($viewerRole, ['resident', 'staff'], true)) {
        privatePhotoError(403, 'Access denied.', 'ACCESS_DENIED');
    }

    // =========================================================
    // FIND PHOTO AND VALIDATE CLAIM PARTICIPANT
    // =========================================================
    $stmt = $conn->prepare(
        'SELECT cp.claim_id,
                cp.photo_path,
                c.claimant_user_id,
                p.user_id AS finder_user_id
           FROM pet_ownership_claim_photos AS cp
           JOIN pet_ownership_claims AS c ON c.id = cp.claim_id
           JOIN pet_reports AS p ON p.id = c.found_report_id
          WHERE cp.id = :photo_id
            AND p.report_type = :report_type
          LIMIT 1'
    );
    $stmt->bindValue(':photo_id', $photoId, PDO::PARAM_INT);
    $stmt->bindValue(':report_type', 'found', PDO::PARAM_STR);
    $stmt->execute();
    $photo = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!is_array($photo)) {
        privatePhotoError(404, 'Evidence photo not found.', 'PHOTO_NOT_FOUND');
    }

    $authorized = $viewerRole === 'staff'
        || $viewerId === (int) $photo['claimant_user_id']
        || $viewerId === (int) $photo['finder_user_id'];

    if (!$authorized) {
        // Avoid revealing private claim/photo IDs to unrelated users.
        privatePhotoError(404, 'Evidence photo not found.', 'PHOTO_NOT_FOUND');
    }

    // =========================================================
    // VERIFY THE STORED RELATIVE PATH
    // upload_claim_photo.php stores:
    // ownership_claims/<claim_id>/<40 lowercase hex>.(jpg|png|webp)
    // =========================================================
    $claimId = (string) $photo['claim_id'];
    $storedPath = (string) ($photo['photo_path'] ?? '');
    $relativePath = str_replace('\\', '/', $storedPath);

    if (
        preg_match(
            '~\Aownership_claims/([1-9][0-9]*)/([a-f0-9]{40})\.(jpg|png|webp)\z~D',
            $relativePath,
            $parts
        ) !== 1
        || $parts[1] !== $claimId
    ) {
        privatePhotoLog('INVALID_STORED_PATH', $photoId, 'claim_id=' . $claimId);
        privatePhotoError(
            422,
            'The uploaded photo record has an invalid internal path.',
            'INVALID_STORED_PATH'
        );
    }

    $extension = $parts[3];
    $mimeByExtension = [
        'jpg'  => 'image/jpeg',
        'png'  => 'image/png',
        'webp' => 'image/webp'
    ];
    $expectedMime = $mimeByExtension[$extension];

    // Both upload and viewer use the same XAMPP root, NOT htdocs.
    // Example: C:/xampp/pawrescue_private/ownership_claims/1/abc.jpg
    $xamppRoot = dirname(__DIR__, 4);
    $privateRoot = realpath(
        $xamppRoot . DIRECTORY_SEPARATOR . 'pawrescue_private'
    );

    if ($privateRoot === false || !is_dir($privateRoot)) {
        privatePhotoLog('PRIVATE_STORAGE_MISSING', $photoId);
        privatePhotoError(
            404,
            'The private evidence storage folder is missing on the server.',
            'PRIVATE_STORAGE_MISSING'
        );
    }

    $candidatePath = $privateRoot . DIRECTORY_SEPARATOR
        . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    $actualPath = realpath($candidatePath);

    if ($actualPath === false || !is_file($actualPath)) {
        privatePhotoLog('PHOTO_FILE_MISSING', $photoId, 'claim_id=' . $claimId);
        privatePhotoError(
            404,
            'The evidence photo file is missing from the server.',
            'PHOTO_FILE_MISSING'
        );
    }

    // Verify that a symbolic link cannot redirect private evidence
    // to a location outside the expected storage directory.
    $privatePrefix = rtrim($privateRoot, '\\/') . DIRECTORY_SEPARATOR;
    $insideStorage = PHP_OS_FAMILY === 'Windows'
        ? strncasecmp($actualPath, $privatePrefix, strlen($privatePrefix)) === 0
        : strncmp($actualPath, $privatePrefix, strlen($privatePrefix)) === 0;

    if (!$insideStorage) {
        privatePhotoLog('UNSAFE_PHOTO_PATH', $photoId);
        privatePhotoError(404, 'Evidence photo not found.', 'PHOTO_NOT_FOUND');
    }

    if (!is_readable($actualPath)) {
        privatePhotoLog('PHOTO_NOT_READABLE', $photoId);
        privatePhotoError(
            500,
            'The server cannot read this evidence photo.',
            'PHOTO_NOT_READABLE'
        );
    }

    // =========================================================
    // VALIDATE REAL IMAGE DATA BEFORE ANY BINARY HEADERS
    // =========================================================
    $fileSize = @filesize($actualPath);
    if (!is_int($fileSize) || $fileSize <= 0 || $fileSize > 5 * 1024 * 1024) {
        privatePhotoLog('INVALID_PHOTO_SIZE', $photoId);
        privatePhotoError(422, 'Evidence photo has an invalid file size.', 'INVALID_PHOTO_SIZE');
    }

    // A 5 MB maximum allows us to load and validate the full image
    // before sending the response; no partial JPEG/PNG/WebP streams.
    $imageBytes = @file_get_contents($actualPath);
    if (!is_string($imageBytes) || strlen($imageBytes) !== $fileSize) {
        privatePhotoLog('PHOTO_READ_FAILED', $photoId);
        privatePhotoError(500, 'Unable to read the evidence photo.', 'PHOTO_READ_FAILED');
    }

    $mimeDetector = new finfo(FILEINFO_MIME_TYPE);
    $actualMime = $mimeDetector->buffer($imageBytes);
    $imageInfo = @getimagesizefromstring($imageBytes);

    if (
        $actualMime !== $expectedMime
        || !is_array($imageInfo)
        || ($imageInfo['mime'] ?? '') !== $expectedMime
        || (int) ($imageInfo[0] ?? 0) < 1
        || (int) ($imageInfo[1] ?? 0) < 1
    ) {
        privatePhotoLog(
            'INVALID_IMAGE_DATA',
            $photoId,
            'expected=' . $expectedMime . ', detected=' . (string) $actualMime
        );
        privatePhotoError(
            422,
            'Evidence file is not a valid image of its recorded type.',
            'INVALID_IMAGE_DATA'
        );
    }

    // =========================================================
    // OUTPUT BINARY IMAGE ONLY - NO JSON, HTML OR PHP NOTICES
    // =========================================================
    clearPrivatePhotoOutput();

    header_remove('Content-Type');
    header_remove('Content-Length');
    http_response_code(200);
    header('Content-Type: ' . $expectedMime);
    header('Content-Length: ' . strlen($imageBytes));
    header('Content-Disposition: inline; filename="ownership-evidence.' . $extension . '"');
    header('Cache-Control: private, no-store, max-age=0');
    header('X-Content-Type-Options: nosniff');

    echo $imageBytes;
    exit;

} catch (Throwable $e) {
    privatePhotoLog('UNEXPECTED_ERROR', $photoId, $e->getMessage());
    privatePhotoError(
        500,
        'Unable to view ownership evidence photo.',
        'PHOTO_SERVER_ERROR'
    );
}
