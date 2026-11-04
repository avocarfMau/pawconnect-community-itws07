<?php
// =====================================
// PAWRESCUE COMMUNITY
// PET ADOPTION - CREATE POST
// =====================================
// CORS / OPTIONS handling remains centralized in .htaccess / cors.php.
// This endpoint creates ONE adoption post. Pet photos are uploaded separately.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// =====================================
// PERFORMANCE DIAGNOSTICS
// =====================================
// In the browser Network tab, Server-Timing reports how long PHP spent
// processing the request. It does NOT include the full upload/network time.

$requestStartedAt = microtime(true);
$insertStartedAt = null;
$insertFinishedAt = null;

function reply(int $code, array $body): void
{
    global $requestStartedAt, $insertStartedAt, $insertFinishedAt;

    $now = microtime(true);
    $totalMs = max(0.0, ($now - $requestStartedAt) * 1000);
    $timing = ['total;dur=' . number_format($totalMs, 1, '.', '')];

    if ($insertStartedAt !== null) {
        $insertEnd = $insertFinishedAt ?? $now;
        $insertMs = max(0.0, ($insertEnd - $insertStartedAt) * 1000);
        $timing[] = 'insert;dur=' . number_format($insertMs, 1, '.', '');
    }

    header('Server-Timing: ' . implode(', ', $timing));

    // Only successful slow operations are logged; no resident or pet details.
    if ($code === 201 && $totalMs >= 2000) {
        error_log(
            '[PawRescue Adoption Create Post] Slow request: ' .
            number_format($totalMs, 1, '.', '') . ' ms'
        );
    }

    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// =====================================
// REQUEST VALIDATION
// =====================================

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    reply(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

$contentType = (string) ($_SERVER['CONTENT_TYPE'] ?? '');

if (!preg_match('/^application\/json(?:\s*;|\s*$)/i', $contentType)) {
    reply(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// A text-only listing is small. Limit unexpectedly large JSON requests.
// The actual body is also capped below in case Content-Length is missing.
$maxBodyBytes = 32 * 1024;
$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);

if ($contentLength > $maxBodyBytes) {
    reply(413, [
        'success' => false,
        'message' => 'Adoption post details are too large.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // =====================================
    // RESIDENT AUTHENTICATION
    // =====================================

    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $userId = (int) $auth['user']['id'];

    // =====================================
    // READ JSON BODY
    // =====================================

    $rawBody = file_get_contents('php://input', false, null, 0, $maxBodyBytes + 1);

    if ($rawBody === false || strlen($rawBody) > $maxBodyBytes) {
        reply(413, [
            'success' => false,
            'message' => 'Adoption post details are too large.'
        ]);
    }

    try {
        $data = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid JSON request.'
        ]);
    }

    if (!is_array($data) || array_is_list($data)) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid JSON request.'
        ]);
    }

    // =====================================
    // REQUIRED FIELDS
    // =====================================

    $required = ['pet_name', 'animal_type', 'description', 'barangay'];

    foreach ($required as $field) {
        if (
            !isset($data[$field]) ||
            !is_string($data[$field]) ||
            trim($data[$field]) === ''
        ) {
            reply(400, [
                'success' => false,
                'message' => 'Please complete all required fields.'
            ]);
        }
    }

    $petName = trim($data['pet_name']);
    $animalType = trim($data['animal_type']);
    $description = trim($data['description']);
    $barangay = trim($data['barangay']);
    $sex = $data['sex'] ?? 'unknown';
    $ageMonths = $data['age_months'] ?? null;
    $breed = $data['breed'] ?? null;
    $healthNotes = $data['health_notes'] ?? null;
    $locationDetails = $data['location_details'] ?? null;

    // =====================================
    // PET INFORMATION VALIDATION
    // =====================================

    if (
        mb_strlen($petName) > 100 ||
        mb_strlen($description) > 5000 ||
        !in_array($animalType, ['dog', 'cat'], true) ||
        !is_string($sex) ||
        !in_array($sex, ['male', 'female', 'unknown'], true)
    ) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid pet information.'
        ]);
    }

    $barangays = [
        'San Bartolome', 'Burgos', 'Rizal', 'Bonifacio', 'Mallorca',
        'Mambangnan', 'Diversion', 'Tambo-Adorable', 'Nieves',
        'Tabuating', 'Magpapalayoc', 'San Anton', 'Castellano',
        'Tagumpay', 'San Roque'
    ];

    if (!in_array($barangay, $barangays, true)) {
        reply(400, [
            'success' => false,
            'message' => 'Please select a valid San Leonardo barangay.'
        ]);
    }

    // =====================================
    // AGE VALIDATION
    // =====================================

    if ($ageMonths === '') {
        $ageMonths = null;
    }

    if ($ageMonths !== null) {
        $ageMonths = filter_var(
            $ageMonths,
            FILTER_VALIDATE_INT,
            ['options' => ['min_range' => 0, 'max_range' => 600]]
        );

        if ($ageMonths === false) {
            reply(400, [
                'success' => false,
                'message' => 'Age must be between 0 and 600 months.'
            ]);
        }
    }

    // =====================================
    // OPTIONAL TEXT VALIDATION
    // =====================================

    $optional = [
        'breed' => &$breed,
        'health_notes' => &$healthNotes,
        'location_details' => &$locationDetails
    ];

    $maxLength = [
        'breed' => 120,
        'health_notes' => 3000,
        'location_details' => 255
    ];

    foreach ($optional as $key => &$value) {
        if ($value !== null && !is_string($value)) {
            reply(400, [
                'success' => false,
                'message' => 'Invalid ' . $key . '.'
            ]);
        }

        if ($value !== null) {
            $value = trim($value);

            if (mb_strlen($value) > $maxLength[$key]) {
                reply(400, [
                    'success' => false,
                    'message' => ucfirst(str_replace('_', ' ', $key)) . ' is too long.'
                ]);
            }

            if ($value === '') {
                $value = null;
            }
        }
    }
    unset($value);

    // =====================================
    // CREATE ADOPTION POST
    // =====================================
    // Keep the INSERT and the API response compatible with existing pages.
    // Do not auto-retry failed/uncertain requests: the INSERT may have worked
    // even when its response did not reach the resident's device.

    $insertStartedAt = microtime(true);

    $stmt = $conn->prepare(
        "INSERT INTO pet_adoption_posts
         (user_id, pet_name, animal_type, sex, age_months,
          breed, description, health_notes, barangay, location_details, status)
         VALUES
         (:user_id, :pet_name, :animal_type, :sex, :age_months,
          :breed, :description, :health_notes, :barangay, :location_details, 'available')"
    );

    $stmt->execute([
        ':user_id' => $userId,
        ':pet_name' => $petName,
        ':animal_type' => $animalType,
        ':sex' => $sex,
        ':age_months' => $ageMonths,
        ':breed' => $breed,
        ':description' => $description,
        ':health_notes' => $healthNotes,
        ':barangay' => $barangay,
        ':location_details' => $locationDetails
    ]);

    $adoptionId = (int) $conn->lastInsertId();
    $insertFinishedAt = microtime(true);

    reply(201, [
        'success' => true,
        'message' => 'Pet adoption post created successfully.',
        'adoption_id' => $adoptionId
    ]);

} catch (Throwable $e) {
    error_log('[PawRescue Adoption Create Post] ' . $e->getMessage());

    reply(500, [
        'success' => false,
        'message' => 'Unable to create adoption post.'
    ]);
}
