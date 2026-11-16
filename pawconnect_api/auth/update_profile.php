<?php


header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function sendEditProfileResponse(int $status, bool $success, string $message, array $extra = []): void
{
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

// =====================================
// REQUEST VALIDATION
// =====================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendEditProfileResponse(405, false, 'Method not allowed.');
}

if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === false) {
    sendEditProfileResponse(415, false, 'Content-Type must be application/json.');
}

$data = json_decode(file_get_contents('php://input'), true);
if (!is_array($data) || array_is_list($data)) {
    sendEditProfileResponse(400, false, 'Invalid JSON request.');
}

// These names and validation rules follow the existing register.php.
$requiredFields = [
    'first_name',
    'last_name',
    'username',
    'contact_number'
];

foreach ($requiredFields as $field) {
    if (!isset($data[$field]) || !is_string($data[$field]) || trim($data[$field]) === '') {
        sendEditProfileResponse(422, false, 'Please complete all required profile fields.');
    }
}

if (isset($data['middle_name']) && !is_string($data['middle_name'])) {
    sendEditProfileResponse(422, false, 'Invalid middle name.');
}

$firstName = trim($data['first_name']);
$middleName = trim($data['middle_name'] ?? '');
$lastName = trim($data['last_name']);
$username = trim($data['username']);
$contactNumber = trim($data['contact_number']);

// Do not accept multiline / hidden control characters in profile fields.
foreach ([$firstName, $middleName, $lastName] as $name) {
    if (preg_match('/[\x00-\x1F\x7F]/', $name)) {
        sendEditProfileResponse(422, false, 'Names must not contain line breaks or control characters.');
    }
}

if (
    $firstName === '' || $lastName === '' ||
    mb_strlen($firstName) > 100 ||
    mb_strlen($middleName) > 100 ||
    mb_strlen($lastName) > 100
) {
    sendEditProfileResponse(422, false, 'First and last names are required; each name must be 100 characters or fewer.');
}

$nameParts = [$firstName];
if ($middleName !== '') {
    $nameParts[] = $middleName;
}
$nameParts[] = $lastName;
$fullName = implode(' ', $nameParts);

if (mb_strlen($fullName) > 150) {
    sendEditProfileResponse(422, false, 'Combined full name must not exceed 150 characters.');
}

if (!preg_match('/^[a-zA-Z0-9_]{3,50}$/D', $username)) {
    sendEditProfileResponse(422, false, 'Username must be 3-50 characters and contain only letters, numbers, or underscores.');
}

if (!preg_match('/^\+?[0-9]{10,15}$/D', $contactNumber)) {
    sendEditProfileResponse(422, false, 'Invalid contact number.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $userId = (int) $auth['user']['id'];

    if ($userId <= 0) {
        sendEditProfileResponse(401, false, 'Invalid authenticated session.');
    }

    // Re-read the authoritative account from the database. Email and role
    // are not editable here. Changing email requires its own verification flow.
    $currentStmt = $conn->prepare(
        "SELECT id, email
         FROM users
         WHERE id = :user_id AND role = 'resident' AND status = 'active'
         LIMIT 1"
    );
    $currentStmt->execute([':user_id' => $userId]);
    $current = $currentStmt->fetch(PDO::FETCH_ASSOC);

    if (!$current) {
        sendEditProfileResponse(403, false, 'Your resident account is not available for editing.');
    }

    // Reject an attempted email change rather than silently ignoring it.
    if (array_key_exists('email', $data)) {
        if (!is_string($data['email']) ||
            strcasecmp(trim($data['email']), (string) $current['email']) !== 0) {
            sendEditProfileResponse(422, false, 'Email cannot be changed here. A verified email-change process is required.');
        }
    }

    // Check usernames case-insensitively. A DB unique index should still be
    // kept on users.username to protect against concurrent changes.
    $check = $conn->prepare(
        'SELECT id
         FROM users
         WHERE id <> :user_id AND LOWER(username) = LOWER(:username)
         LIMIT 1'
    );
    $check->execute([
        ':user_id' => $userId,
        ':username' => $username
    ]);

    if ($check->fetchColumn() !== false) {
        sendEditProfileResponse(409, false, 'Username is already taken.');
    }

    // Single atomic update; the resident cannot update another account,
    // change role/status, or update a password through this endpoint.
    $update = $conn->prepare(
        "UPDATE users
         SET first_name = :first_name,
             middle_name = :middle_name,
             last_name = :last_name,
             full_name = :full_name,
             username = :username,
             contact_number = :contact_number
         WHERE id = :user_id AND role = 'resident' AND status = 'active'"
    );

    $update->execute([
        ':first_name' => $firstName,
        ':middle_name' => $middleName !== '' ? $middleName : null,
        ':last_name' => $lastName,
        ':full_name' => $fullName,
        ':username' => $username,
        ':contact_number' => $contactNumber,
        ':user_id' => $userId
    ]);

    // A row count of 0 can mean no fields changed: treat that as success.
    sendEditProfileResponse(200, true, 'Profile updated successfully.', [
        'user' => [
            'id' => $userId,
            'first_name' => $firstName,
            'middle_name' => $middleName !== '' ? $middleName : null,
            'last_name' => $lastName,
            'full_name' => $fullName,
            'email' => (string) $current['email'],
            'username' => $username,
            'contact_number' => $contactNumber,
            'role' => 'resident'
        ]
    ]);
} catch (PDOException $e) {
    error_log('[PawRescue Edit Profile DB] ' . $e->getMessage());

    if ($e->getCode() === '23000') {
        sendEditProfileResponse(409, false, 'Username is already taken.');
    }

    sendEditProfileResponse(500, false, 'Unable to save your profile. Please try again.');
} catch (Throwable $e) {
    error_log('[PawRescue Edit Profile] ' . $e->getMessage());
    sendEditProfileResponse(500, false, 'Unable to update your profile. Please try again.');
}
