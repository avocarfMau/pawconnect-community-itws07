<?php
/**
 * PawConnect - Deactivate the authenticated resident's or staff member's Android FCM token.
 * Only the matching authenticated user/device registration can be deactivated.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store, private');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

// Keep this trusted-origin list aligned with save_device_token.php and CORS config.
$allowedOrigins = [
    'http://localhost:8100',
    'http://127.0.0.1:8100',
    'http://192.168.100.23:8100',
    'http://localhost:8101',
    'http://10.253.195.97:8100',
    'http://localhost',
    'https://localhost',
];

$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$originAllowed = $origin !== '' && in_array($origin, $allowedOrigins, true);
header('Vary: Origin');

if ($originAllowed) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
}

function sendDeactivateResponse(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

$method = (string) ($_SERVER['REQUEST_METHOD'] ?? '');
if ($method === 'OPTIONS') {
    if (!$originAllowed) {
        http_response_code(403);
        exit;
    }
    http_response_code(204);
    exit;
}

if ($method !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendDeactivateResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

$contentType = trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
if (!preg_match('~^application/json(?:\s*;|\s*$)~i', $contentType)) {
    sendDeactivateResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// Read at most 4 KB + 1 byte. Do not process arbitrary-sized payloads.
$rawBody = file_get_contents('php://input', false, null, 0, 4097);
if ($rawBody === false || strlen($rawBody) > 4096) {
    sendDeactivateResponse(413, [
        'success' => false,
        'message' => 'Request body is too large.'
    ]);
}

$data = json_decode($rawBody, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
    sendDeactivateResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$deviceToken = $data['device_token'] ?? null;
if (!is_string($deviceToken)) {
    sendDeactivateResponse(400, [
        'success' => false,
        'message' => 'A Firebase device token is required.'
    ]);
}

$deviceToken = trim($deviceToken);
$tokenLength = strlen($deviceToken);
if (
    $tokenLength < 20 ||
    $tokenLength > 1024 ||
    preg_match('/[^\x21-\x7E]/', $deviceToken)
) {
    sendDeactivateResponse(400, [
        'success' => false,
        'message' => 'Invalid Firebase device token.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    $auth = authenticate(['resident', 'staff']);
    $conn = $auth['connection'] ?? null;
    $userId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $userId <= 0) {
        throw new RuntimeException('Invalid authenticated user session.');
    }

    // Never unlink another account's token if this phone changed accounts.
    $stmt = $conn->prepare(
        'UPDATE user_push_tokens
         SET is_active = 0,
             updated_at = NOW()
         WHERE user_id = :user_id
           AND device_token = :device_token
           AND platform = :platform
           AND is_active = 1'
    );
    $stmt->execute([
        ':user_id' => $userId,
        ':device_token' => $deviceToken,
        ':platform' => 'android'
    ]);

    $deactivated = $stmt->rowCount() === 1;

    // Missing or already-disabled tokens are safe no-ops.
    sendDeactivateResponse(200, [
        'success' => true,
        'message' => $deactivated
            ? 'Push notifications disabled for this device.'
            : 'No active device registration needed deactivation.',
        'deactivated' => $deactivated
    ]);
} catch (Throwable $e) {
    // Never log the FCM token, request body, or Authorization header.
    error_log('[PawConnect Push Token Deactivate] ' . get_class($e));

    sendDeactivateResponse(500, [
        'success' => false,
        'message' => 'Unable to disable push notifications for this device.'
    ]);
}
