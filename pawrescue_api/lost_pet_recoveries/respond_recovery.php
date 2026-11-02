<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendRecoveryDecision(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function rejectRecoveryDecision(PDO $conn, int $status, string $message, array $extra = []): void
{
    if ($conn->inTransaction()) {
        $conn->rollBack();
    }
    sendRecoveryDecision($status, array_merge([
        'success' => false,
        'message' => $message
    ], $extra));
}

// ============================================================
// 1. POST + JSON ONLY; NO PHOTO BYTES IN THIS ENDPOINT
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRecoveryDecision(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (!preg_match(
    '~^application/json(?:\s*;|\s*$)~i',
    trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''))
)) {
    sendRecoveryDecision(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

$rawBody = file_get_contents('php://input', false, null, 0, 16385);
if ($rawBody === false || strlen($rawBody) > 16384) {
    sendRecoveryDecision(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$data = json_decode($rawBody, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
    sendRecoveryDecision(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$recoveryId = filter_var(
    $data['recovery_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);
$action = $data['action'] ?? null;

if (
    $recoveryId === false || $recoveryId === null ||
    !is_string($action) || !in_array($action, ['approve', 'reject'], true)
) {
    sendRecoveryDecision(400, [
        'success' => false,
        'message' => 'Provide a valid recovery ID and action (approve or reject).'
    ]);
}

$pickupLocation = null;
$pickupLatitude = null;
$pickupLongitude = null;
$pickupDate = null;
$pickupTime = null;
$rejectionReason = null;

// ============================================================
// 2. VALIDATE APPROVAL'S PRIVATE PICKUP ARRANGEMENT
// ============================================================
if ($action === 'approve') {
    $locationRaw = $data['pickup_location'] ?? null;
    if (!is_string($locationRaw)) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Enter a proposed pickup location.'
        ]);
    }

    $pickupLocation = trim($locationRaw);
    if (
        strlen($pickupLocation) < 5 ||
        strlen($pickupLocation) > 255 ||
        preg_match('/[\x00-\x1F\x7F]/', $pickupLocation)
    ) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Pickup location must be a single line (5 to 255 bytes).'
        ]);
    }

    // Coordinates may be omitted, but never accept only one.
    $latRaw = $data['pickup_latitude'] ?? null;
    $lngRaw = $data['pickup_longitude'] ?? null;
    if (($latRaw === null) !== ($lngRaw === null)) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Provide both pickup coordinates or leave both empty.'
        ]);
    }

    if ($latRaw !== null) {
        if (
            is_bool($latRaw) || is_bool($lngRaw) ||
            !is_numeric($latRaw) || !is_numeric($lngRaw)
        ) {
            sendRecoveryDecision(422, [
                'success' => false,
                'message' => 'Pickup coordinates must be numeric.'
            ]);
        }

        $latitude = (float) $latRaw;
        $longitude = (float) $lngRaw;
        if (
            !is_finite($latitude) || !is_finite($longitude) ||
            $latitude < -90 || $latitude > 90 ||
            $longitude < -180 || $longitude > 180
        ) {
            sendRecoveryDecision(422, [
                'success' => false,
                'message' => 'Pickup coordinates are outside the valid range.'
            ]);
        }

        $pickupLatitude = number_format($latitude, 8, '.', '');
        $pickupLongitude = number_format($longitude, 8, '.', '');
    }

    $dateRaw = $data['pickup_date'] ?? null;
    $timeRaw = $data['pickup_time'] ?? null;

    if (!is_string($dateRaw) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $dateRaw)) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Pickup date must be YYYY-MM-DD.'
        ]);
    }

    [$year, $month, $day] = array_map('intval', explode('-', $dateRaw));
    if (!checkdate($month, $day, $year)) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Pickup date is not a valid calendar date.'
        ]);
    }

    if (
        !is_string($timeRaw) ||
        !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/D', $timeRaw)
    ) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Pickup time must be HH:MM (24-hour format).'
        ]);
    }

    $pickupDate = $dateRaw;
    $pickupTime = strlen($timeRaw) === 5 ? $timeRaw . ':00' : $timeRaw;

    $manila = new DateTimeZone('Asia/Manila');
    $pickupAt = DateTimeImmutable::createFromFormat(
        '!Y-m-d H:i:s',
        $pickupDate . ' ' . $pickupTime,
        $manila
    );
    if (
        !$pickupAt ||
        $pickupAt->format('Y-m-d H:i:s') !== $pickupDate . ' ' . $pickupTime ||
        $pickupAt <= new DateTimeImmutable('now', $manila)
    ) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Choose a future pickup date and time (Asia/Manila).'
        ]);
    }
}

// ============================================================
// 3. VALIDATE OPTIONAL REJECTION REASON
// ============================================================
if ($action === 'reject' && array_key_exists('rejection_reason', $data)) {
    $reasonRaw = $data['rejection_reason'];
    if ($reasonRaw !== null && !is_string($reasonRaw)) {
        sendRecoveryDecision(422, [
            'success' => false,
            'message' => 'Rejection reason must be text.'
        ]);
    }

    if (is_string($reasonRaw)) {
        $rejectionReason = trim($reasonRaw);
        if (mb_strlen($rejectionReason, 'UTF-8') > 1000) {
            sendRecoveryDecision(422, [
                'success' => false,
                'message' => 'Rejection reason must not exceed 1000 characters.'
            ]);
        }
        if ($rejectionReason === '') {
            $rejectionReason = null;
        }
    }
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
try {
    // ========================================================
    // 4. AUTHENTICATE RESIDENT A — OWNER OF LOST PET POST
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $ownerId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $ownerId <= 0) {
        throw new RuntimeException('Invalid authenticated resident session.');
    }

    // This read identifies the parent report to lock FIRST.
    // It is not authorization: we verify report ownership again
    // INSIDE the transaction after acquiring the row lock.
    $lookup = $conn->prepare(
        'SELECT lost_report_id
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id
         LIMIT 1'
    );
    $lookup->execute([':recovery_id' => $recoveryId]);
    $lostReportId = $lookup->fetchColumn();

    if ($lostReportId === false) {
        sendRecoveryDecision(404, [
            'success' => false,
            'message' => 'Recovery submission not found.'
        ]);
    }

    $conn->beginTransaction();

    // All recovery mutation endpoints must lock report -> recovery
    // in this order. The report lock serializes two owners'/
    // finders' competing operations against the same LOST post.
    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :lost_report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':lost_report_id' => $lostReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (
        !$report ||
        $report['report_type'] !== 'lost' ||
        (int) $report['user_id'] !== $ownerId
    ) {
        rejectRecoveryDecision($conn, 404, 'Recovery submission not found.');
    }

    if (!in_array(
        (string) $report['status'],
        ['pending', 'under_review', 'in_progress'],
        true
    )) {
        rejectRecoveryDecision($conn, 409, 'This Lost Pet report is no longer active.');
    }

    $recoveryStmt = $conn->prepare(
        'SELECT id, lost_report_id, finder_user_id, status,
                finding_description, found_location
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id AND lost_report_id = :lost_report_id
         LIMIT 1 FOR UPDATE'
    );
    $recoveryStmt->execute([
        ':recovery_id' => $recoveryId,
        ':lost_report_id' => $lostReportId
    ]);
    $recovery = $recoveryStmt->fetch(PDO::FETCH_ASSOC);

    if (!$recovery) {
        rejectRecoveryDecision($conn, 404, 'Recovery submission not found.');
    }

    if ($recovery['status'] !== 'pending') {
        rejectRecoveryDecision($conn, 409, 'Only pending recovery submissions can be processed.', [
            'status' => (string) $recovery['status']
        ]);
    }

    // The owner must have actual finding details to review.
    // Evidence photos are optional and are fetched via a
    // separate authenticated GET endpoint.
    if (
        $action === 'approve' &&
        (trim((string) $recovery['finding_description']) === '' ||
         trim((string) $recovery['found_location']) === '')
    ) {
        rejectRecoveryDecision($conn, 422, 'Recovery finding details are incomplete.');
    }

    if ($action === 'approve') {
        // No second active pickup; unresolved disputes also block
        // approvals. The parent LOST report is already locked.
        $activeStmt = $conn->prepare(
            "SELECT id FROM pet_lost_recovery_reports
             WHERE lost_report_id = :lost_report_id
               AND id <> :recovery_id
               AND status IN (
                   'approved', 'pickup_scheduled',
                   'reschedule_requested', 'disputed', 'completed'
               )
             LIMIT 1"
        );
        $activeStmt->execute([
            ':lost_report_id' => $lostReportId,
            ':recovery_id' => $recoveryId
        ]);
        if ($activeStmt->fetchColumn() !== false) {
            rejectRecoveryDecision(
                $conn,
                409,
                'Another recovery already has an active pickup or unresolved dispute for this pet.'
            );
        }

        // Approval makes a PRIVATE pickup proposal; Finder B must
        // confirm it separately. This does not complete the recovery.
        $update = $conn->prepare(
            "UPDATE pet_lost_recovery_reports
             SET status = 'pickup_scheduled',
                 approved_at = NOW(),
                 pickup_location = :pickup_location,
                 pickup_latitude = :pickup_latitude,
                 pickup_longitude = :pickup_longitude,
                 pickup_date = :pickup_date,
                 pickup_time = :pickup_time,
                 pickup_timezone = 'Asia/Manila',
                 pickup_confirmed_by_finder_at = NULL,
                 rejection_reason = NULL
             WHERE id = :recovery_id AND status = 'pending'"
        );
        $update->execute([
            ':pickup_location' => $pickupLocation,
            ':pickup_latitude' => $pickupLatitude,
            ':pickup_longitude' => $pickupLongitude,
            ':pickup_date' => $pickupDate,
            ':pickup_time' => $pickupTime,
            ':recovery_id' => $recoveryId
        ]);

        if ($update->rowCount() !== 1) {
            throw new RuntimeException('Recovery changed during approval.');
        }

        // Cancel other PENDING submissions, not reject them:
        // their evidence was not individually judged. Keep all
        // records/photos for authorized historical viewing.
        $closePending = $conn->prepare(
            "UPDATE pet_lost_recovery_reports
             SET status = 'cancelled',
                 cancellation_reason = :reason,
                 cancelled_at = NOW()
             WHERE lost_report_id = :lost_report_id
               AND id <> :approved_recovery_id
               AND status = 'pending'"
        );
        $closePending->execute([
            ':reason' =>
                'Another finder was approved for this Lost Pet. ' .
                'A private pickup is being arranged, so your recovery submission is no longer pending.',
            ':lost_report_id' => $lostReportId,
            ':approved_recovery_id' => $recoveryId
        ]);
        $otherPendingClosed = $closePending->rowCount();

        $conn->commit();
        sendRecoveryDecision(200, [
            'success' => true,
            'message' => 'Recovery approved. Waiting for the finder to confirm the proposed pickup.',
            'recovery_id' => $recoveryId,
            'lost_report_id' => (int) $lostReportId,
            'action' => 'approve',
            'status' => 'pickup_scheduled',
            'other_pending_recoveries_closed' => $otherPendingClosed,
            'pickup' => [
                'location' => $pickupLocation,
                'latitude' => $pickupLatitude === null ? null : (float) $pickupLatitude,
                'longitude' => $pickupLongitude === null ? null : (float) $pickupLongitude,
                'date' => $pickupDate,
                'time' => $pickupTime,
                'timezone' => 'Asia/Manila',
                'finder_confirmed_at' => null
            ]
        ]);
    }

    // Reject ONLY this submission; other finders can still
    // submit while the LOST pet report is active.
    $update = $conn->prepare(
        "UPDATE pet_lost_recovery_reports
         SET status = 'rejected',
             rejection_reason = :rejection_reason,
             rejected_at = NOW()
         WHERE id = :recovery_id AND status = 'pending'"
    );
    $update->execute([
        ':rejection_reason' => $rejectionReason,
        ':recovery_id' => $recoveryId
    ]);

    if ($update->rowCount() !== 1) {
        throw new RuntimeException('Recovery changed during rejection.');
    }

    $conn->commit();
    sendRecoveryDecision(200, [
        'success' => true,
        'message' => 'Recovery submission rejected. The Lost Pet report remains active.',
        'recovery_id' => $recoveryId,
        'lost_report_id' => (int) $lostReportId,
        'action' => 'reject',
        'status' => 'rejected',
        'rejection_reason' => $rejectionReason
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Respond Lost Pet Recovery] ' . $e->getMessage());
    sendRecoveryDecision(500, [
        'success' => false,
        'message' => 'Unable to process this recovery submission.'
    ]);
}
