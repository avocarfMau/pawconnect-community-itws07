<?php
// =====================================
// PAWRESCUE COMMUNITY
// AUTHENTICATED SESSION / MY ACCOUNT PROFILE
// =====================================
// CORS is handled by the existing .htaccess / cors.php.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// =====================================
// JSON RESPONSE HELPER
// =====================================
function sendProfileResponse(int $status, array $payload): void
{
    http_response_code($status);

    $json = json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );

    if ($json === false) {
        http_response_code(500);
        echo '{"success":false,"message":"Unable to prepare account information."}';
        exit;
    }

    echo $json;
    exit;
}

// =====================================
// ALLOW GET REQUESTS ONLY
// =====================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');

    sendProfileResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

// =====================================
// AUTHENTICATE SESSION
// =====================================
require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // Keep this endpoint available to BOTH resident and staff session checks.
    // The middleware verifies the Bearer token and supplies the database
    // connection and authenticated user ID.
    $auth = authenticate();
    $authenticatedUser = $auth['user'] ?? null;
    $conn = $auth['connection'] ?? null;

    if (
        !is_array($authenticatedUser) ||
        !isset($authenticatedUser['id']) ||
        !($conn instanceof PDO)
    ) {
        throw new RuntimeException('Authenticated session information is incomplete.');
    }

    $userId = (int) $authenticatedUser['id'];

    if ($userId <= 0) {
        sendProfileResponse(401, [
            'success' => false,
            'message' => 'Invalid authenticated session.'
        ]);
    }

    // Read the current saved values from the users table so Edit Profile
    // receives the original name components, rather than attempting to
    // split full_name (which is unreliable for multi-part names).
    // This is a single lookup by the authenticated user's ID.
    $stmt = $conn->prepare(
        "SELECT id,
                first_name,
                middle_name,
                last_name,
                full_name,
                email,
                username,
                contact_number,
                role,
                status
         FROM users
         WHERE id = :user_id
         LIMIT 1"
    );

    $stmt->execute([':user_id' => $userId]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user || $user['status'] !== 'active') {
        sendProfileResponse(401, [
            'success' => false,
            'message' => 'This account is no longer available.'
        ]);
    }

    // Barangay is not collected by the existing registration endpoint.
    // Keep this legacy optional response field without querying a
    // database column that may not exist.
    $barangay = $authenticatedUser['barangay'] ?? null;

    sendProfileResponse(200, [
        'success' => true,
        'message' => 'Authenticated successfully.',
        'user' => [
            'id' => (int) $user['id'],
            'first_name' => (string) ($user['first_name'] ?? ''),
            'middle_name' => $user['middle_name'] !== null
                ? (string) $user['middle_name']
                : null,
            'last_name' => (string) ($user['last_name'] ?? ''),
            'full_name' => (string) $user['full_name'],
            'email' => (string) $user['email'],
            'username' => (string) $user['username'],
            'contact_number' => $user['contact_number'] !== null
                ? (string) $user['contact_number']
                : null,
            'barangay' => is_string($barangay) ? $barangay : null,
            'role' => (string) $user['role']
        ]
    ]);
} catch (Throwable $e) {
    error_log('[PawRescue Auth Me] ' . $e->getMessage());

    sendProfileResponse(500, [
        'success' => false,
        'message' => 'Unable to verify session or load account information.'
    ]);
}
