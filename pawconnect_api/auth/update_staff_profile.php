<?php
// ============================================================
// PAWCONNECT — BARANGAY STAFF PROFILE UPDATE
// Save as: pawconnect_api/auth/update_staff_profile.php
//
// Staff-only counterpart to the resident update_profile.php.
// Changes ONLY the authenticated staff user's own name, username,
// and contact number. Email, password, role and status stay unchanged.
// ============================================================

// Existing Apache .htaccess / cors.php handles CORS.
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function sendStaffProfileResponse(
    int $status,
    bool $success,
    string $message,
    array $extra = []
): void {
    http_response_code($status);
    echo json_encode(
        array_merge([
            'success' => $success,
            'message' => $message
        ], $extra),
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendStaffProfileResponse(405, false, 'Method not allowed.');
}

if (!preg_match(
    '~^application/json(?:\s*;|\s*$)~i',
    trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''))
)) {
    sendStaffProfileResponse(415, false, 'Content-Type must be application/json.');
}

// Limit unnecessary request payloads. These five profile fields are small.
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) {
    sendStaffProfileResponse(413, false, 'Profile update request is too large.');
}

$raw = file_get_contents('php://input');
if (!is_string($raw) || strlen($raw) > 16384) {
    sendStaffProfileResponse(413, false, 'Profile update request is too large.');
}

$data = json_decode($raw, true);
if (!is_array($data) || array_is_list($data)) {
    sendStaffProfileResponse(400, false, 'Invalid JSON request.');
}

foreach (['first_name', 'last_name', 'username', 'contact_number'] as $field) {
    if (!isset($data[$field]) ||
        !is_string($data[$field]) ||
        trim($data[$field]) === '') {
        sendStaffProfileResponse(422, false, 'Please complete all required profile fields.');
    }
}

if (isset($data['middle_name']) && !is_string($data['middle_name'])) {
    sendStaffProfileResponse(422, false, 'Invalid middle name.');
}

$firstName = trim($data['first_name']);
$middleName = trim($data['middle_name'] ?? '');
$lastName = trim($data['last_name']);
$username = trim($data['username']);
$contactNumber = trim($data['contact_number']);

foreach ([$firstName, $middleName, $lastName] as $name) {
    if (preg_match('/[\x00-\x1F\x7F]/', $name)) {
        sendStaffProfileResponse(422, false, 'Names must not contain line breaks or control characters.');
    }
}

if (
    $firstName === '' ||
    $lastName === '' ||
    mb_strlen($firstName) > 100 ||
    mb_strlen($middleName) > 100 ||
    mb_strlen($lastName) > 100
) {
    sendStaffProfileResponse(
        422,
        false,
        'First and last names are required; each name must be 100 characters or fewer.'
    );
}

$nameParts = [$firstName];
if ($middleName !== '') {
    $nameParts[] = $middleName;
}
$nameParts[] = $lastName;
$fullName = implode(' ', $nameParts);

if (mb_strlen($fullName) > 150) {
    sendStaffProfileResponse(422, false, 'Combined full name must not exceed 150 characters.');
}

if (!preg_match('/^[a-zA-Z0-9_]{3,50}$/D', $username)) {
    sendStaffProfileResponse(
        422,
        false,
        'Username must be 3–50 characters using only letters, numbers, or underscores.'
    );
}

if (!preg_match('/^[0-9]{11}$/D', $contactNumber)) {
    sendStaffProfileResponse(422, false, 'Contact number must contain exactly 11 digits (numbers only).');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // Identity is taken from the bearer token, NEVER from JSON or query params.
    $auth = authenticate(['staff']);
    $conn = $auth['connection'] ?? null;
    $staffId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $staffId <= 0) {
        sendStaffProfileResponse(401, false, 'Invalid authenticated staff session.');
    }

    // Enforce role/status from the database as well as in middleware.
    $currentStmt = $conn->prepare(
        "SELECT id, email
         FROM users
         WHERE id = :user_id
           AND role = 'staff'
           AND status = 'active'
         LIMIT 1"
    );
    $currentStmt->execute([':user_id' => $staffId]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);

    if (!$current) {
        sendStaffProfileResponse(403, false, 'This staff account is not available for editing.');
    }

    // If email was supplied, ensure that it is unchanged.
    if (array_key_exists('email', $data)) {
        if (!is_string($data['email']) ||
            strcasecmp(trim($data['email']), (string) $current['email']) !== 0) {
            sendStaffProfileResponse(
                422,
                false,
                'Email cannot be changed here. A verified email-change process is required.'
            );
        }
    }

    // Keep the account username unique among ALL users.
    $check = $conn->prepare(
        "SELECT id
         FROM users
         WHERE id <> :user_id
           AND LOWER(username) = LOWER(:username)
         LIMIT 1"
    );
    $check->execute([
        ':user_id' => $staffId,
        ':username' => $username
    ]);
    if ($check->fetchColumn() !== false) {
        sendStaffProfileResponse(409, false, 'Username is already taken.');
    }

    // Staff can change their OWN profile fields, nothing else.
    $update = $conn->prepare(
        "UPDATE users
         SET first_name = :first_name,
             middle_name = :middle_name,
             last_name = :last_name,
             full_name = :full_name,
             username = :username,
             contact_number = :contact_number
         WHERE id = :user_id
           AND role = 'staff'
           AND status = 'active'"
    );

    $update->execute([
        ':first_name' => $firstName,
        ':middle_name' => $middleName !== '' ? $middleName : null,
        ':last_name' => $lastName,
        ':full_name' => $fullName,
        ':username' => $username,
        ':contact_number' => $contactNumber,
        ':user_id' => $staffId
    ]);

    sendStaffProfileResponse(200, true, 'Profile updated successfully.', [
        'user' => [
            'id' => $staffId,
            'first_name' => $firstName,
            'middle_name' => $middleName !== '' ? $middleName : null,
            'last_name' => $lastName,
            'full_name' => $fullName,
            'email' => (string) $current['email'],
            'username' => $username,
            'contact_number' => $contactNumber,
            'role' => 'staff'
        ]
    ]);
} catch (PDOException $e) {
    error_log('[PawConnect Staff Profile Update DB] ' . $e->getMessage());
    if ((string) $e->getCode() === '23000') {
        sendStaffProfileResponse(409, false, 'Username is already taken.');
    }
    sendStaffProfileResponse(500, false, 'Unable to save your profile. Please try again.');
} catch (Throwable $e) {
    error_log('[PawConnect Staff Profile Update] ' . $e->getMessage());
    sendStaffProfileResponse(500, false, 'Unable to update your profile. Please try again.');
}
