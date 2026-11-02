<?php


header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendRecoveryResponse(int $httpStatus, array $body): void
{
    http_response_code($httpStatus);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function rejectRecovery(PDO $conn, int $httpStatus, string $message, array $extra = []): void
{
    if ($conn->inTransaction()) {
        $conn->rollBack();
    }

    sendRecoveryResponse($httpStatus, array_merge([
        'success' => false,
        'message' => $message
    ], $extra));
}

// ============================================================
// 1. REQUIRE POST + JSON
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRecoveryResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (!preg_match(
    '~^application/json(?:\s*;|\s*$)~i',
    trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''))
)) {
    sendRecoveryResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// Limit JSON requests to 16 KiB. Images must not be sent as JSON.
$rawBody = file_get_contents('php://input', false, null, 0, 16385);
if ($rawBody === false || strlen($rawBody) > 16384) {
    sendRecoveryResponse(413, [
        'success' => false,
        'message' => 'Finding information is too large.'
    ]);
}

$data = json_decode($rawBody, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

// ============================================================
// 2. VALIDATE LOST REPORT AND OPTIONAL LINK
// ============================================================
$lostReportId = filter_var(
    $data['lost_report_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);
if ($lostReportId === false || $lostReportId === null) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Select a valid Lost Pet report.'
    ]);
}

$linkedFoundReportId = $data['linked_found_report_id'] ?? null;
if ($linkedFoundReportId === '') {
    $linkedFoundReportId = null;
}
if ($linkedFoundReportId !== null) {
    $linkedFoundReportId = filter_var(
        $linkedFoundReportId,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );
    if ($linkedFoundReportId === false) {
        sendRecoveryResponse(400, [
            'success' => false,
            'message' => 'The linked Found Pet report ID is invalid.'
        ]);
    }
}

// ============================================================
// 3. VALIDATE PRIVATE FINDING DETAILS
// ============================================================
$description = $data['finding_description'] ?? null;
if (!is_string($description)) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Describe where and how you found the pet.'
    ]);
}
$description = trim($description);
if (mb_strlen($description, 'UTF-8') < 10 || mb_strlen($description, 'UTF-8') > 3000) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Finding description must be between 10 and 3000 characters.'
    ]);
}

$foundLocation = $data['found_location'] ?? null;
if (!is_string($foundLocation)) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Provide a location where you found the pet.'
    ]);
}
$foundLocation = trim($foundLocation);
if (mb_strlen($foundLocation, 'UTF-8') < 5 || mb_strlen($foundLocation, 'UTF-8') > 255) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Found location must be between 5 and 255 characters.'
    ]);
}

// Both coordinates must be present together. Do not treat zero
// as missing; zero is a valid geographical coordinate.
$latitude = $data['found_latitude'] ?? null;
$longitude = $data['found_longitude'] ?? null;
if ($latitude === '' || $longitude === '') {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Provide both GPS coordinates, or leave both empty.'
    ]);
}
if (($latitude === null) !== ($longitude === null)) {
    sendRecoveryResponse(400, [
        'success' => false,
        'message' => 'Latitude and longitude must be supplied together.'
    ]);
}
if ($latitude !== null) {
    if (
        is_bool($latitude) || is_bool($longitude) ||
        !is_numeric($latitude) || !is_numeric($longitude)
    ) {
        sendRecoveryResponse(400, [
            'success' => false,
            'message' => 'GPS coordinates must be numeric.'
        ]);
    }

    $latitude = (float) $latitude;
    $longitude = (float) $longitude;
    if (
        !is_finite($latitude) || !is_finite($longitude) ||
        $latitude < -90 || $latitude > 90 ||
        $longitude < -180 || $longitude > 180
    ) {
        sendRecoveryResponse(400, [
            'success' => false,
            'message' => 'GPS coordinates are outside the valid range.'
        ]);
    }

    // Match the table's DECIMAL(10,8) and DECIMAL(11,8).
    $latitude = number_format($latitude, 8, '.', '');
    $longitude = number_format($longitude, 8, '.', '');
}

// found_at is an OPTIONAL local date/time (Asia/Manila).
// Accept YYYY-MM-DD HH:MM, YYYY-MM-DD HH:MM:SS, or HTML
// datetime-local format YYYY-MM-DDTHH:MM[:SS].
$foundAt = $data['found_at'] ?? null;
if ($foundAt === '') {
    $foundAt = null;
}
if ($foundAt !== null) {
    if (!is_string($foundAt) || !preg_match(
        '/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/D',
        $foundAt
    )) {
        sendRecoveryResponse(400, [
            'success' => false,
            'message' => 'Found date/time must be YYYY-MM-DD HH:MM (Asia/Manila).'
        ]);
    }

    $normalized = str_replace('T', ' ', $foundAt);
    if (strlen($normalized) === 16) {
        $normalized .= ':00';
    }

    $manila = new DateTimeZone('Asia/Manila');
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $normalized, $manila);
    if (!$parsed || $parsed->format('Y-m-d H:i:s') !== $normalized) {
        sendRecoveryResponse(400, [
            'success' => false,
            'message' => 'Found date/time is not a valid calendar date.'
        ]);
    }

    if ($parsed > new DateTimeImmutable('now', $manila)) {
        sendRecoveryResponse(400, [
            'success' => false,
            'message' => 'Found date/time cannot be in the future.'
        ]);
    }
    $foundAt = $normalized;
}

// ============================================================
// 4. AUTHENTICATE FINDER AND START SERIALIZED TRANSACTION
// ============================================================
require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $finderId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $finderId <= 0) {
        throw new RuntimeException('Incomplete authenticated resident session.');
    }

    $conn->beginTransaction();

    // Lock the parent LOST report FIRST. All subsequent recovery
    // approval/resolution endpoints must use this same lock order.
    $lostStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :report_id
         LIMIT 1 FOR UPDATE'
    );
    $lostStmt->execute([':report_id' => $lostReportId]);
    $lostReport = $lostStmt->fetch(PDO::FETCH_ASSOC);

    if (!$lostReport || $lostReport['report_type'] !== 'lost') {
        rejectRecovery($conn, 404, 'Lost Pet report not found.');
    }
    if ((int) $lostReport['user_id'] === $finderId) {
        rejectRecovery($conn, 403, 'You cannot submit a finding for your own Lost Pet report.');
    }
    if (!in_array(
        (string) $lostReport['status'],
        ['pending', 'under_review', 'in_progress'],
        true
    )) {
        rejectRecovery($conn, 409, 'This Lost Pet report is no longer accepting recovery submissions.');
    }

    // ========================================================
    // 5. PREVENT A REPEAT SUBMISSION BY THE SAME FINDER
    // ========================================================
    $duplicateStmt = $conn->prepare(
        'SELECT id, status
         FROM pet_lost_recovery_reports
         WHERE lost_report_id = :lost_report_id
           AND finder_user_id = :finder_id
         LIMIT 1'
    );
    $duplicateStmt->execute([
        ':lost_report_id' => $lostReportId,
        ':finder_id' => $finderId
    ]);
    $duplicate = $duplicateStmt->fetch(PDO::FETCH_ASSOC);

    if ($duplicate) {
        rejectRecovery($conn, 409, 'You already submitted a finding for this Lost Pet.', [
            'recovery_id' => (int) $duplicate['id'],
            'status' => (string) $duplicate['status']
        ]);
    }

    // ========================================================
    // 6. BLOCK NEW FINDINGS IF AN ACTIVE PICKUP / DISPUTE EXISTS
    // ========================================================
    $unavailableStmt = $conn->prepare(
        "SELECT status
         FROM pet_lost_recovery_reports
         WHERE lost_report_id = :lost_report_id
           AND status IN (
               'approved', 'pickup_scheduled',
               'reschedule_requested', 'disputed', 'completed'
           )
         LIMIT 1"
    );
    $unavailableStmt->execute([':lost_report_id' => $lostReportId]);
    $unavailable = $unavailableStmt->fetchColumn();

    if ($unavailable !== false) {
        $reason = ($unavailable === 'disputed')
            ? 'Recovery submissions are temporarily unavailable while a previous finding is disputed.'
            : (($unavailable === 'completed')
                ? 'This Lost Pet has already been returned.'
                : 'A finder has already been approved and pickup is being arranged for this pet.');
        rejectRecovery($conn, 409, $reason);
    }

    // ========================================================
    // 7. CHECK OPTIONAL LINKED FOUND PET REPORT
    // ========================================================
    if ($linkedFoundReportId !== null) {
        $linkedStmt = $conn->prepare(
            "SELECT id
             FROM pet_reports
             WHERE id = :found_report_id
               AND user_id = :finder_id
               AND report_type = 'found'
               AND status IN ('pending', 'under_review', 'in_progress')
             LIMIT 1"
        );
        $linkedStmt->execute([
            ':found_report_id' => $linkedFoundReportId,
            ':finder_id' => $finderId
        ]);
        if (!$linkedStmt->fetchColumn()) {
            rejectRecovery(
                $conn,
                422,
                'The linked Found Pet report must be an active report owned by your account.'
            );
        }
    }

    // ========================================================
    // 8. CREATE A PENDING RECOVERY RECORD — NO AUTO-APPROVAL
    // ========================================================
    $insertStmt = $conn->prepare(
        "INSERT INTO pet_lost_recovery_reports (
             lost_report_id, finder_user_id, linked_found_report_id,
             finding_description, found_location,
             found_latitude, found_longitude, found_at,
             status
         ) VALUES (
             :lost_report_id, :finder_id, :linked_found_report_id,
             :finding_description, :found_location,
             :found_latitude, :found_longitude, :found_at,
             'pending'
         )"
    );
    $insertStmt->execute([
        ':lost_report_id' => $lostReportId,
        ':finder_id' => $finderId,
        ':linked_found_report_id' => $linkedFoundReportId,
        ':finding_description' => $description,
        ':found_location' => $foundLocation,
        ':found_latitude' => $latitude,
        ':found_longitude' => $longitude,
        ':found_at' => $foundAt
    ]);

    $recoveryId = (int) $conn->lastInsertId();
    if ($recoveryId <= 0) {
        throw new RuntimeException('Recovery ID not returned after insert.');
    }

    $conn->commit();
    sendRecoveryResponse(201, [
        'success' => true,
        'message' => 'Finding report submitted. The pet owner can review it before arranging a return.',
        'recovery_id' => $recoveryId,
        'lost_report_id' => (int) $lostReportId,
        'status' => 'pending',
        'next_step' => 'Upload private evidence photos, if available.'
    ]);
} catch (PDOException $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Lost Pet Recovery Submit] ' . $e->getMessage());

    // Unique constraint guarantees no duplicate finder/report pair,
    // even if another request raced with this one.
    $mysqlErrorCode = (int) ($e->errorInfo[1] ?? 0);
    if ($mysqlErrorCode === 1062) {
        sendRecoveryResponse(409, [
            'success' => false,
            'message' => 'You already submitted a finding for this Lost Pet.'
        ]);
    }

    sendRecoveryResponse(500, [
        'success' => false,
        'message' => 'Unable to submit the finding report.'
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Lost Pet Recovery Submit] ' . $e->getMessage());
    sendRecoveryResponse(500, [
        'success' => false,
        'message' => 'Unable to submit the finding report.'
    ]);
}
