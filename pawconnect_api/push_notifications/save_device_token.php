<?php
/**
 * PawRescue Community - Register the current resident's Android FCM token.
 *
 * Only authenticated residents may save a token. The server derives the user
 * ID from the Bearer token; the client cannot choose an account ID.
 *
 * This endpoint supports the OPTIONS preflight sent by an Ionic/Capacitor
 * WebView when it POSTs JSON with an Authorization header in live-reload mode.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store, private');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

// Only explicitly trusted PawRescue development origins may read responses.
// Origin includes the scheme and port; the Ionic live-reload port is 8100.
// Keep these in sync with the allowed origins in the project's main CORS file.
$allowedOrigins = [
    'http://localhost:8100',
    'http://127.0.0.1:8100',
    'http://192.168.100.23:8100',
    'http://192.168.100.66:8100',
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

function sendDeviceTokenResponse(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

$method = (string) ($_SERVER['REQUEST_METHOD'] ?? '');

// Answer a permitted browser/WebView preflight before authentication or
// JSON validation. Preflight requests do not contain the Bearer token.
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
    sendDeviceTokenResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

$contentType = trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
if (!preg_match('~^application/json(?:\s*;|\s*$)~i', $contentType)) {
    sendDeviceTokenResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// A token is small: reject oversized requests before decoding arbitrary input.
$rawBody = file_get_contents('php://input', false, null, 0, 4097);
if ($rawBody === false || strlen($rawBody) > 4096) {
    sendDeviceTokenResponse(413, [
        'success' => false,
        'message' => 'Request body is too large.'
    ]);
}

$data = json_decode($rawBody, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
    sendDeviceTokenResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$deviceToken = $data['device_token'] ?? null;
if (!is_string($deviceToken)) {
    sendDeviceTokenResponse(400, [
        'success' => false,
        'message' => 'A Firebase device token is required.'
    ]);
}

$deviceToken = trim($deviceToken);
$tokenLength = strlen($deviceToken);

// FCM tokens are opaque: validate length and the ASCII storage constraints.
if (
    $tokenLength < 20 ||
    $tokenLength > 1024 ||
    preg_match('/[^\x21-\x7E]/', $deviceToken)
) {
    sendDeviceTokenResponse(400, [
        'success' => false,
        'message' => 'Invalid Firebase device token.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $residentId <= 0) {
        throw new RuntimeException('Invalid authenticated resident session.');
    }

    // One atomic upsert; reassign a token to the resident currently signed in
    // on the device and refresh its last-seen timestamp without duplicating it.
    $stmt = $conn->prepare(
        'INSERT INTO user_push_tokens
            (user_id, device_token, platform, is_active, last_seen_at)
         VALUES
            (:user_id, :device_token, :platform, 1, NOW())
         ON DUPLICATE KEY UPDATE
            user_id = VALUES(user_id),
            platform = VALUES(platform),
            is_active = 1,
            last_seen_at = NOW(),
            updated_at = NOW()'
    );
    $stmt->execute([
        ':user_id' => $residentId,
        ':device_token' => $deviceToken,
        ':platform' => 'android'
    ]);

    sendDeviceTokenResponse(200, [
        'success' => true,
        'message' => 'Device registered for push notifications.',
        'registered' => true,
        'platform' => 'android'
    ]);
} catch (Throwable $e) {
    // Never log request bodies, authentication tokens, or FCM device tokens.
    error_log('[PawRescue Push Token Save] ' . get_class($e));

    sendDeviceTokenResponse(500, [
        'success' => false,
        'message' => 'Unable to register this device for push notifications.'
    ]);
}
