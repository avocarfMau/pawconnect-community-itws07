
<?php

// =====================================
// PAWRESCUE COMMUNITY
// RESIDENT REGISTRATION API
// =====================================

// CORS is handled automatically by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// JSON RESPONSE HELPER
// =====================================

function respond($status, $success, $message) {

    http_response_code($status);

    echo json_encode([
        "success" => $success,
        "message" => $message
    ]);

    exit;
}

// =====================================
// ALLOW POST REQUESTS ONLY
// =====================================

// OPTIONS requests are handled
// automatically by cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    header("Allow: POST, OPTIONS");

    respond(
        405,
        false,
        "Method not allowed."
    );
}

// =====================================
// DATABASE CONFIGURATION
// =====================================

require_once __DIR__ . "/../config/database.php";

// =====================================
// VALIDATE CONTENT TYPE
// =====================================

$contentType =
    $_SERVER["CONTENT_TYPE"] ?? "";

if (
    stripos(
        $contentType,
        "application/json"
    ) === false
) {

    respond(
        415,
        false,
        "Content-Type must be application/json."
    );
}

// =====================================
// READ JSON REQUEST
// =====================================

$data = json_decode(
    file_get_contents("php://input"),
    true
);

if (
    !is_array($data) ||
    array_is_list($data)
) {

    respond(
        400,
        false,
        "Invalid JSON request."
    );
}

// =====================================
// REQUIRED REGISTRATION FIELDS
// =====================================

$fields = [
    "first_name",
    "last_name",
    "email",
    "username",
    "contact_number",
    "password",
    "confirm_password"
];

foreach ($fields as $field) {

    if (
        !isset($data[$field]) ||
        !is_string($data[$field]) ||
        trim($data[$field]) === ""
    ) {

        respond(
            400,
            false,
            "Please complete all required fields."
        );
    }
}

// =====================================
// OPTIONAL MIDDLE NAME
// =====================================

if (
    isset($data["middle_name"]) &&
    !is_string($data["middle_name"])
) {

    respond(
        400,
        false,
        "Invalid middle name."
    );
}

// =====================================
// RETRIEVE REGISTRATION INFORMATION
// =====================================

$firstName = trim(
    $data["first_name"]
);

$middleName = trim(
    $data["middle_name"] ?? ""
);

$lastName = trim(
    $data["last_name"]
);

$email = strtolower(
    trim($data["email"])
);

$username = trim(
    $data["username"]
);

$contact = trim(
    $data["contact_number"]
);

$password = $data["password"];

$confirmPassword =
    $data["confirm_password"];

// =====================================
// VALIDATE NAME LENGTHS
// =====================================

if (
    mb_strlen($firstName) > 100 ||
    mb_strlen($middleName) > 100 ||
    mb_strlen($lastName) > 100
) {

    respond(
        400,
        false,
        "Each name field must not exceed 100 characters."
    );
}

// =====================================
// GENERATE FULL NAME
// =====================================

$nameParts = [$firstName];

if ($middleName !== "") {
    $nameParts[] = $middleName;
}

$nameParts[] = $lastName;

$fullName = implode(
    " ",
    $nameParts
);

if (
    mb_strlen($fullName) > 150
) {

    respond(
        400,
        false,
        "Combined full name must not exceed 150 characters."
    );
}

// =====================================
// VALIDATE EMAIL
// =====================================

if (
    !filter_var(
        $email,
        FILTER_VALIDATE_EMAIL
    ) ||
    strlen($email) > 150
) {

    respond(
        400,
        false,
        "Invalid email address."
    );
}

// =====================================
// VALIDATE USERNAME
// =====================================

if (
    !preg_match(
        '/^[a-zA-Z0-9_]{3,50}$/',
        $username
    )
) {

    respond(
        400,
        false,
        "Username must be 3-50 characters and contain only letters, numbers, or underscores."
    );
}

// =====================================
// VALIDATE CONTACT NUMBER
// =====================================

if (
    !preg_match(
        '/^\+?[0-9]{10,15}$/',
        $contact
    )
) {

    respond(
        400,
        false,
        "Invalid contact number."
    );
}

// =====================================
// VALIDATE PASSWORD LENGTH
// =====================================

if (
    strlen($password) < 8 ||
    strlen($password) > 72
) {

    respond(
        400,
        false,
        "Password must be 8-72 characters."
    );
}

// =====================================
// VALIDATE PASSWORD CONFIRMATION
// =====================================

if (
    $password !== $confirmPassword
) {

    respond(
        400,
        false,
        "Passwords do not match."
    );
}

// =====================================
// REGISTER RESIDENT
// =====================================

try {

    // Connect to database
    $db = new Database();

    $conn = $db->connect();

    // =====================================
    // CHECK EXISTING EMAIL OR USERNAME
    // =====================================

    $check = $conn->prepare(
        "SELECT
            email,
            username
         FROM users
         WHERE email = :email
            OR username = :username"
    );

    $check->execute([
        ":email" => $email,
        ":username" => $username
    ]);

    $existing = $check->fetchAll(
        PDO::FETCH_ASSOC
    );

    foreach ($existing as $user) {

        if (
            strcasecmp(
                $user["email"],
                $email
            ) === 0
        ) {

            respond(
                409,
                false,
                "Email is already registered."
            );
        }

        if (
            strcasecmp(
                $user["username"],
                $username
            ) === 0
        ) {

            respond(
                409,
                false,
                "Username is already taken."
            );
        }
    }

    // =====================================
    // HASH PASSWORD
    // =====================================

    $hashedPassword = password_hash(
        $password,
        PASSWORD_DEFAULT
    );

    // =====================================
    // INSERT RESIDENT ACCOUNT
    // =====================================

    $insert = $conn->prepare(
        "INSERT INTO users (
            first_name,
            middle_name,
            last_name,
            full_name,
            email,
            username,
            contact_number,
            password_hash,
            role,
            status
        )
        VALUES (
            :first_name,
            :middle_name,
            :last_name,
            :full_name,
            :email,
            :username,
            :contact_number,
            :password_hash,
            'resident',
            'active'
        )"
    );

    $insert->execute([
        ":first_name" => $firstName,
        ":middle_name" => (
            $middleName !== ""
                ? $middleName
                : null
        ),
        ":last_name" => $lastName,
        ":full_name" => $fullName,
        ":email" => $email,
        ":username" => $username,
        ":contact_number" => $contact,
        ":password_hash" => $hashedPassword
    ]);

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    respond(
        201,
        true,
        "Registration successful! You can now log in."
    );

} catch (PDOException $e) {

    // Handle duplicate email or username
    if (
        $e->getCode() === "23000"
    ) {

        respond(
            409,
            false,
            "Email or username already exists."
        );
    }

    error_log(
        "PawRescue Registration Database Error: " .
        $e->getMessage()
    );

    respond(
        500,
        false,
        "Registration failed. Please try again."
    );

} catch (Throwable $e) {

    error_log(
        "PawRescue Registration Error: " .
        $e->getMessage()
    );

    respond(
        500,
        false,
        "An unexpected error occurred."
    );
}
