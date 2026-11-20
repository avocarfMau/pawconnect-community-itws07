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
// BEST-EFFORT FCM NOTICE TO THE SPECIFIC RESIDENT
// ============================================================
// This is an internal helper, never a public notification endpoint.
// The caller supplies user IDs obtained from authorized recovery records,
// not IDs supplied by the client. A browser-only account has no Android
// FCM token; it can still check recovery status through get_recoveries.php.
// IMPORTANT: Call only AFTER the claim transaction commits.
function notifyRecoveryResident(
    PDO $conn,
    int $recipientId,
    string $title,
    string $message,
    string $type,
    int $recoveryId,
    int $lostReportId,
    string $status
): void {
    if ($recipientId <= 0) {
        return;
    }

    try {
        // The most recently active device for THIS resident only.
        // We intentionally do not send to other user accounts or
        // broadcast to every device in the database.
        $tokenStmt = $conn->prepare(
            "SELECT id, device_token
             FROM user_push_tokens
             WHERE user_id = :recipient_id
               AND platform = 'android'
               AND is_active = 1
             ORDER BY last_seen_at DESC, id DESC
             LIMIT 1"
        );
        $tokenStmt->execute([':recipient_id' => $recipientId]);
        $device = $tokenStmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($device) || !is_string($device['device_token'] ?? null)
            || $device['device_token'] === '') {
            return;
        }

        require_once __DIR__ . '/../push_notifications/fcm_sender.php';

        $send = pawrescueSendFcmToToken(
            $device['device_token'],
            $title,
            $message,
            [
                'type' => $type,
                'route' => '/my-recoveries',
                'recoveries_tab' => 'sent',
                'recovery_id' => (string) $recoveryId,
                'lost_report_id' => (string) $lostReportId,
                'status' => $status
            ]
        );

        if (($send['unregistered'] ?? false) === true) {
            // The device token is no longer recognized by Firebase.
            // Deactivate exactly this registration, and do not touch
            // an entry reassigned to a different resident meanwhile.
            $disable = $conn->prepare(
                'UPDATE user_push_tokens
                 SET is_active = 0, updated_at = NOW()
                 WHERE id = :token_id
                   AND user_id = :recipient_id
                   AND device_token = :device_token
                   AND platform = :platform
                   AND is_active = 1'
            );
            $disable->execute([
                ':token_id' => (int) $device['id'],
                ':recipient_id' => $recipientId,
                ':device_token' => $device['device_token'],
                ':platform' => 'android'
            ]);
        }

        if (($send['success'] ?? false) !== true) {
            // Do not log the FCM token, credentials, or private recovery data.
            error_log('[PawConnect Recovery Decision Push] Firebase did not accept a notice.');
        }
    } catch (Throwable $pushError) {
        // A notification error must not invalidate an approved/rejected recovery.
        error_log(
            '[PawConnect Recovery Decision Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

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

    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $ownerId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $ownerId <= 0) {
        throw new RuntimeException('Invalid authenticated resident session.');
    }

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

    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status, deleted_at
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

    // Archived Lost Pet reports cannot accept new recovery decisions.
    if ($report['deleted_at'] !== null) {
        rejectRecoveryDecision($conn, 409,
            'This Lost Pet report has been archived. Recovery decisions are no longer allowed.'
        );
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

    if (
        $action === 'approve' &&
        (trim((string) $recovery['finding_description']) === '' ||
         trim((string) $recovery['found_location']) === '')
    ) {
        rejectRecoveryDecision($conn, 422, 'Recovery finding details are incomplete.');
    }

    if ($action === 'approve') {

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

        // Capture the other pending finders before the atomic cancellation.
        // These recipients are determined from the locked Lost Pet report,
        // never from a client-supplied user ID.
        $otherPendingStmt = $conn->prepare(
            "SELECT id, finder_user_id
             FROM pet_lost_recovery_reports
             WHERE lost_report_id = :lost_report_id
               AND id <> :approved_recovery_id
               AND status = 'pending'"
        );
        $otherPendingStmt->execute([
            ':lost_report_id' => $lostReportId,
            ':approved_recovery_id' => $recoveryId
        ]);
        $otherPendingRecipients = $otherPendingStmt->fetchAll(PDO::FETCH_ASSOC);

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

        notifyRecoveryResident(
            $conn,
            (int) $recovery['finder_user_id'],
            'Lost Pet Recovery Approved',
            'Your recovery submission was approved. Open PawConnect to review the pickup arrangement.',
            'lost_recovery_approved',
            $recoveryId,
            (int) $lostReportId,
            'pickup_scheduled'
        );

        foreach ($otherPendingRecipients as $otherRecovery) {
            $otherRecoveryId = (int) ($otherRecovery['id'] ?? 0);
            $otherFinderId = (int) ($otherRecovery['finder_user_id'] ?? 0);
            if ($otherRecoveryId <= 0 || $otherFinderId <= 0) {
                continue;
            }
            notifyRecoveryResident(
                $conn,
                $otherFinderId,
                'Lost Pet Recovery Closed',
                'Another finder was approved for this Lost Pet. Your recovery submission is no longer pending.',
                'lost_recovery_cancelled',
                $otherRecoveryId,
                (int) $lostReportId,
                'cancelled'
            );
        }

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

    notifyRecoveryResident(
        $conn,
        (int) $recovery['finder_user_id'],
        'Lost Pet Recovery Update',
        'Your recovery submission was not approved. Open PawConnect to view the result.',
        'lost_recovery_rejected',
        $recoveryId,
        (int) $lostReportId,
        'rejected'
    );

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
    error_log('[PawConnect Respond Lost Pet Recovery] ' . $e->getMessage());
    sendRecoveryDecision(500, [
        'success' => false,
        'message' => 'Unable to process this recovery submission.'
    ]);
}
