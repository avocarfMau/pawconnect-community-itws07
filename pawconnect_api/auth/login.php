
<?php

// =====================================
// RESPONSE HEADERS
// =====================================

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// CORS CONFIGURATION
// =====================================

// Allowed Ionic / WebNative development origins.
$allowedOrigins = [
    "http://localhost:8100",
    "http://127.0.0.1:8100",
    "http://192.168.100.23:8100"
];

// Get the actual frontend origin.
$origin = $_SERVER["HTTP_ORIGIN"] ?? "";

// Allow only trusted development origins.
if (in_array($origin, $allowedOrigins, true)) {

    header("Access-Control-Allow-Origin: " . $origin);
    header("Vary: Origin");
}

header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Access-Control-Max-Age: 600");

// =====================================
// HANDLE PREFLIGHT REQUEST
// =====================================

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {

    http_response_code(204);

    exit;
}

// =====================================
// JSON RESPONSE HELPER
// =====================================

function respond($status, $data) {

    http_response_code($status);

    echo json_encode($data);

    exit;
}

// =====================================
// ALLOW POST REQUESTS ONLY
// =====================================

if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    header("Allow: POST, OPTIONS");

    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

// =====================================
// DATABASE CONFIGURATION
// =====================================

require_once __DIR__ . "/../config/database.php";

// =====================================
// VALIDATE CONTENT TYPE
// =====================================

if (
    stripos(
        $_SERVER["CONTENT_TYPE"] ?? "",
        "application/json"
    ) === false
) {

    respond(415, [
        "success" => false,
        "message" => "Content-Type must be application/json."
    ]);
}

// =====================================
// DECODE JSON REQUEST
// =====================================

$data = json_decode(
    file_get_contents("php://input"),
    true
);

if (!is_array($data)) {

    respond(400, [
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
}

// =====================================
// VALIDATE LOGIN CREDENTIALS
// =====================================

$login = $data["login"] ?? null;
$password = $data["password"] ?? null;

if (
    !is_string($login) ||
    trim($login) === "" ||
    !is_string($password) ||
    $password === ""
) {

    respond(400, [
        "success" => false,
        "message" => "Email/username and password are required."
    ]);
}

$login = trim($login);

// =====================================
// AUTHENTICATE USER
// =====================================

try {

    $db = new Database();

    $conn = $db->connect();

    // =====================================
    // LOOK UP USER
    // =====================================

    $stmt = $conn->prepare(
        "SELECT
            id,
            full_name,
            email,
            username,
            password_hash,
            role,
            status
         FROM users
         WHERE email = :email
            OR username = :username
         LIMIT 1"
    );

    $stmt->execute([
        ":email" => $login,
        ":username" => $login
    ]);

    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    // =====================================
    // VERIFY PASSWORD
    // =====================================

    if (
        !$user ||
        !password_verify(
            $password,
            $user["password_hash"]
        )
    ) {

        respond(401, [
            "success" => false,
            "message" => "Invalid login credentials."
        ]);
    }

    // =====================================
    // VERIFY ACCOUNT STATUS
    // =====================================

    if ($user["status"] !== "active") {

        respond(403, [
            "success" => false,
            "message" => "This account is inactive."
        ]);
    }

    // =====================================
    // GENERATE AUTHENTICATION TOKEN
    // =====================================

    $token = bin2hex(
        random_bytes(32)
    );

    $tokenHash = hash(
        "sha256",
        $token
    );

    // Token expires after 24 hours UTC.
    $expiresAt = gmdate(
        "Y-m-d H:i:s",
        time() + 86400
    );

    // =====================================
    // STORE TOKEN IN DATABASE
    // =====================================

    $insert = $conn->prepare(
        "INSERT INTO auth_tokens
            (user_id, token_hash, expires_at)
         VALUES
            (:user_id, :token_hash, :expires_at)"
    );

    $insert->execute([
        ":user_id" => $user["id"],
        ":token_hash" => $tokenHash,
        ":expires_at" => $expiresAt
    ]);

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    respond(200, [
        "success" => true,
        "message" => "Login successful!",
        "token" => $token,
        "token_type" => "Bearer",
        "expires_at" => $expiresAt . " UTC",
        "user" => [
            "id" => (int) $user["id"],
            "full_name" => $user["full_name"],
            "email" => $user["email"],
            "username" => $user["username"],
            "role" => $user["role"]
        ]
    ]);

} catch (Throwable $e) {

    error_log(
        "PawRescue Login Error: " .
        $e->getMessage()
    );

    respond(500, [
        "success" => false,
        "message" => "Unable to process login."
    ]);
}
