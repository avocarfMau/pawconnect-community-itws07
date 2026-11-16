
<?php

require_once __DIR__ . "/../config/database.php";

// =====================================
// AUTHENTICATION ERROR RESPONSE
// =====================================

function authError($status, $message) {
    http_response_code($status);

    header("Content-Type: application/json; charset=UTF-8");

    echo json_encode([
        "success" => false,
        "message" => $message
    ]);

    exit;
}

// =====================================
// AUTHENTICATE ACCESS TOKEN
// =====================================

function authenticate($allowedRoles = []) {

    $authStart = microtime(true);

    // Retrieve Authorization header
    $header = $_SERVER["HTTP_AUTHORIZATION"]
        ?? $_SERVER["REDIRECT_HTTP_AUTHORIZATION"]
        ?? "";

    if (!$header && function_exists("getallheaders")) {
        foreach (getallheaders() as $key => $value) {

            if (strcasecmp($key, "Authorization") === 0) {
                $header = $value;
                break;
            }
        }
    }

    // Validate Bearer token format
    if (
        !preg_match(
            '/^Bearer ([a-f0-9]{64})$/i',
            trim($header),
            $matches
        )
    ) {
        authError(
            401,
            "Missing or invalid authentication token."
        );
    }

    // Hash token before database lookup
    $tokenHash = hash(
        "sha256",
        strtolower($matches[1])
    );

    // =====================================
    // DATABASE CONNECTION
    // =====================================

    $connectionStart = microtime(true);

    $database = new Database();
    $conn = $database->connect();

    $connectionMs = round(
        (microtime(true) - $connectionStart) * 1000,
        2
    );

    error_log(
        "[PawRescue Auth] Database Connection: " .
        $connectionMs . " ms"
    );

    // =====================================
    // VERIFY TOKEN IN DATABASE
    // =====================================

    $queryStart = microtime(true);

    $stmt = $conn->prepare(
        "SELECT
            u.id,
            u.full_name,
            u.email,
            u.username,
            u.contact_number,
            u.role,
            u.status,
            t.id AS token_id
         FROM auth_tokens t
         INNER JOIN users u
            ON u.id = t.user_id
         WHERE t.token_hash = :token_hash
           AND t.revoked_at IS NULL
           AND t.expires_at > UTC_TIMESTAMP()
         LIMIT 1"
    );

    $stmt->execute([
        ":token_hash" => $tokenHash
    ]);

    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    $queryMs = round(
        (microtime(true) - $queryStart) * 1000,
        2
    );

    error_log(
        "[PawRescue Auth] Token Query: " .
        $queryMs . " ms"
    );

    // =====================================
    // VALIDATE ACCOUNT STATUS
    // =====================================

    if (
        !$user ||
        $user["status"] !== "active"
    ) {
        authError(
            401,
            "Session expired or invalid. Please log in again."
        );
    }

    // =====================================
    // ROLE-BASED ACCESS CONTROL
    // =====================================

    if (
        !empty($allowedRoles) &&
        !in_array(
            $user["role"],
            $allowedRoles,
            true
        )
    ) {
        authError(
            403,
            "You do not have permission to access this resource."
        );
    }

    // =====================================
    // TOTAL AUTHENTICATION TIME
    // =====================================

    $totalMs = round(
        (microtime(true) - $authStart) * 1000,
        2
    );

    error_log(
        "[PawRescue Auth] Total Authentication: " .
        $totalMs . " ms"
    );

    // Return authenticated user and connection
    return [
        "connection" => $conn,
        "user" => $user
    ];
}
