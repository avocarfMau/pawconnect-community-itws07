
<?php

// =====================================
// PAWRESCUE COMMUNITY
// LOGOUT API
// =====================================

// CORS is handled automatically by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// JSON RESPONSE HELPER
// =====================================

function sendLogoutResponse(
    int $status,
    bool $success,
    string $message
): void {

    http_response_code($status);

    echo json_encode([
        "success" => $success,
        "message" => $message
    ]);

    exit;
}

// =====================================
// VALIDATE REQUEST METHOD
// =====================================

// OPTIONS is handled by centralized cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    header("Allow: POST, OPTIONS");

    sendLogoutResponse(
        405,
        false,
        "Method not allowed."
    );
}

// =====================================
// AUTHENTICATION MIDDLEWARE
// =====================================

require_once __DIR__ .
    "/../middleware/auth_middleware.php";

try {

    // =====================================
    // AUTHENTICATE CURRENT USER
    // =====================================

    $auth = authenticate();

    $conn = $auth["connection"];

    $tokenId = $auth["user"]["token_id"] ?? null;

    if (
        !filter_var(
            $tokenId,
            FILTER_VALIDATE_INT,
            ["options" => ["min_range" => 1]]
        )
    ) {

        throw new RuntimeException(
            "Authenticated token ID is missing."
        );
    }

    // =====================================
    // REVOKE CURRENT AUTHENTICATION TOKEN
    // =====================================

    $stmt = $conn->prepare(
        "UPDATE auth_tokens
         SET revoked_at = UTC_TIMESTAMP()
         WHERE id = :token_id
           AND revoked_at IS NULL"
    );

    $stmt->execute([
        ":token_id" => (int) $tokenId
    ]);

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    sendLogoutResponse(
        200,
        true,
        "Logout successful!"
    );

} catch (Throwable $e) {

    error_log(
        "[PawRescue Logout Error] " .
        $e->getMessage()
    );

    sendLogoutResponse(
        500,
        false,
        "Unable to process logout."
    );
}
