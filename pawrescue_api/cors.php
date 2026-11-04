
<?php
// =====================================
// PAWRESCUE COMMUNITY
// CENTRALIZED CORS CONFIGURATION
// =====================================

// Trusted development origins
$allowedOrigins = [
    "http://localhost:8100",
    "http://127.0.0.1:8100",
    "http://192.168.100.23:8100",
    // "http://192.168.100.23:8100",
    "https://localhost",
    "http://localhost"
];

// =====================================
// GET REQUEST ORIGIN
// =====================================

$origin = $_SERVER["HTTP_ORIGIN"] ?? "";

header("Vary: Origin");

// =====================================
// VALIDATE ORIGIN
// =====================================

$originAllowed = in_array(
    $origin,
    $allowedOrigins,
    true
);

if ($originAllowed) {
    header(
        "Access-Control-Allow-Origin: " . $origin
    );
}

// =====================================
// ALLOWED METHODS AND HEADERS
// =====================================

header(
    "Access-Control-Allow-Methods: GET, POST, OPTIONS"
);

header(
    "Access-Control-Allow-Headers: Content-Type, Authorization"
);

header(
    "Access-Control-Max-Age: 600"
);

// =====================================
// HANDLE PREFLIGHT REQUEST
// =====================================

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    if (!$originAllowed) {
        http_response_code(403);
        exit;
    }

    http_response_code(204);
    exit;
}
