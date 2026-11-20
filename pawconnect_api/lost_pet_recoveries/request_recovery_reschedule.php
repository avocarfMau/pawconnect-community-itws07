<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendRecoveryRescheduleResponse(int $code, array $data): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function failRecoveryReschedule(PDO $conn, int $code, string $message, array $details = []): void
{
    if ($conn->inTransaction()) {
        $conn->rollBack();
    }
    sendRecoveryRescheduleResponse($code, array_merge([
        'success' => false,
        'message' => $message
    ], $details));
}

function requiredRecoveryRescheduleId(array $data, string $field): int
{
    $value = $data[$field] ?? null;
    if (
        !(is_int($value) || is_string($value)) ||
        !preg_match('/^[1-9][0-9]*$/D', (string) $value)
    ) {
        sendRecoveryRescheduleResponse(400, [
            'success' => false,
            'message' => 'A valid ' . $field . ' is required.'
        ]);
    }
    $number = filter_var($value, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1]
    ]);
    if ($number === false) {
        sendRecoveryRescheduleResponse(400, [
            'success' => false,
            'message' => 'A valid ' . $field . ' is required.'
        ]);
    }
    return (int) $number;
}

function optionalRecoveryNote(array $data, string $field): ?string
{
    if (!array_key_exists($field, $data) || $data[$field] === null) {
        return null;
    }
    if (!is_string($data[$field])) {
        sendRecoveryRescheduleResponse(422, [
            'success' => false,
            'message' => $field . ' must be text.'
        ]);
    }
    $value = trim($data[$field]);

    $characters = preg_match_all('/./us', $value);
    if ($characters === false || $characters > 1000) {
        sendRecoveryRescheduleResponse(422, [
            'success' => false,
            'message' => $field . ' cannot exceed 1000 characters.'
        ]);
    }
    return $value === '' ? null : $value;
}

function recoveryCoordEqual($a, $b): bool
{
    if ($a === null || $b === null) {
        return $a === null && $b === null;
    }
    return is_numeric($a) && is_numeric($b) &&
        number_format((float) $a, 8, '.', '') ===
        number_format((float) $b, 8, '.', '');
}

function recoveryPickupInfo(
    string $location,
    $latitude,
    $longitude,
    string $date,
    string $time
): array {
    return [
        'location' => $location,
        'latitude' => $latitude === null ? null : (float) $latitude,
        'longitude' => $longitude === null ? null : (float) $longitude,
        'date' => $date,
        'time' => $time,
        'timezone' => 'Asia/Manila'
    ];
}

function validFutureRecoveryPickup(string $date, string $time): bool
{
    $tz = new DateTimeZone('Asia/Manila');
    $dt = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $date . ' ' . $time, $tz);
    return $dt !== false &&
        $dt->format('Y-m-d H:i:s') === $date . ' ' . $time &&
        $dt > new DateTimeImmutable('now', $tz);
}

// ============================================================
// BEST-EFFORT FCM NOTICE TO THE SPECIFIC RESIDENT
// ============================================================
// This is an internal helper, never a public notification endpoint.
// The caller supplies user IDs obtained from authorized recovery records,
// not IDs supplied by the client. A browser-only account has no Android
// FCM token; it can still check recovery status through get_recoveries.php.
// IMPORTANT: Call only AFTER the recovery transaction commits.
function notifyRecoveryActionResident(
    PDO $conn,
    int $recipientId,
    string $title,
    string $message,
    string $type,
    int $recoveryId,
    int $lostReportId,
    string $status,
    string $tab
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
                'recoveries_tab' => $tab,
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
            error_log('[PawConnect Recovery Action Push] Firebase did not accept a notice.');
        }
    } catch (Throwable $pushError) {
        // A notification error must not invalidate an saved recovery action.
        error_log(
            '[PawConnect Recovery Action Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRecoveryRescheduleResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (!preg_match(
    '~^application/json(?:\s*;|\s*$)~i',
    trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''))
)) {
    sendRecoveryRescheduleResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

$raw = file_get_contents('php://input', false, null, 0, 8193);
if ($raw === false || strlen($raw) > 8192) {
    sendRecoveryRescheduleResponse(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$data = json_decode($raw, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
    sendRecoveryRescheduleResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$action = $data['action'] ?? 'request';
if (!is_string($action) || !in_array($action, ['request', 'accept', 'reject', 'confirm_handover'], true)) {
    sendRecoveryRescheduleResponse(400, [
        'success' => false,
        'message' => 'Action must be request, accept, reject, or confirm_handover.'
    ]);
}

$recoveryId = requiredRecoveryRescheduleId($data, 'recovery_id');
$rescheduleId = in_array($action, ['accept', 'reject'], true)
    ? requiredRecoveryRescheduleId($data, 'reschedule_id')
    : null;

$inputLocation = null;
$inputDate = null;
$inputTime = null;
$inputLatitude = null;
$inputLongitude = null;
$coordinatesSpecified = false;
$reason = null;
$responseNote = null;

if ($action === 'request') {

    if (array_key_exists('pickup_location', $data)) {
        if (!is_string($data['pickup_location'])) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Pickup location must be text.'
            ]);
        }
        $inputLocation = trim($data['pickup_location']);
        if (
            strlen($inputLocation) < 5 || strlen($inputLocation) > 255 ||
            preg_match('/[\x00-\x1F\x7F]/', $inputLocation)
        ) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Pickup location must be one line, 5 to 255 bytes.'
            ]);
        }
    }

    if (array_key_exists('pickup_date', $data)) {
        $inputDate = $data['pickup_date'];
        if (
            !is_string($inputDate) ||
            !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $inputDate)
        ) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Pickup date must use YYYY-MM-DD.'
            ]);
        }
        [$y, $m, $d] = array_map('intval', explode('-', $inputDate));
        if (!checkdate($m, $d, $y)) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Pickup date is invalid.'
            ]);
        }
    }

    if (array_key_exists('pickup_time', $data)) {
        $inputTime = $data['pickup_time'];
        if (
            !is_string($inputTime) ||
            !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/D', $inputTime)
        ) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Pickup time must be HH:MM in 24-hour format.'
            ]);
        }
        if (strlen($inputTime) === 5) {
            $inputTime .= ':00';
        }
    }

    $coordinatesSpecified = array_key_exists('pickup_latitude', $data) ||
        array_key_exists('pickup_longitude', $data);

    if ($coordinatesSpecified) {
        if (
            !array_key_exists('pickup_latitude', $data) ||
            !array_key_exists('pickup_longitude', $data)
        ) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Supply both pickup coordinates or set both to null.'
            ]);
        }
        $latValue = $data['pickup_latitude'];
        $lngValue = $data['pickup_longitude'];
        if (($latValue === null) !== ($lngValue === null)) {
            sendRecoveryRescheduleResponse(422, [
                'success' => false,
                'message' => 'Latitude and longitude must both be set or both null.'
            ]);
        }
        if ($latValue !== null) {
            if (
                is_bool($latValue) || is_bool($lngValue) ||
                !is_numeric($latValue) || !is_numeric($lngValue)
            ) {
                sendRecoveryRescheduleResponse(422, [
                    'success' => false,
                    'message' => 'Coordinates must be numeric.'
                ]);
            }
            $lat = (float) $latValue;
            $lng = (float) $lngValue;
            if (
                !is_finite($lat) || !is_finite($lng) ||
                $lat < -90 || $lat > 90 || $lng < -180 || $lng > 180
            ) {
                sendRecoveryRescheduleResponse(422, [
                    'success' => false,
                    'message' => 'Pickup coordinates are out of range.'
                ]);
            }
            $inputLatitude = number_format($lat, 8, '.', '');
            $inputLongitude = number_format($lng, 8, '.', '');
        }
    }

    $reason = optionalRecoveryNote($data, 'reason');
} elseif ($action === 'confirm_handover') {

    if (($data['confirm_handover'] ?? null) !== true) {
        sendRecoveryRescheduleResponse(422, [
            'success' => false,
            'message' => 'Please confirm that the pet was physically handed over.'
        ]);
    }
} else {
    $responseNote = optionalRecoveryNote($data, 'response_note');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';
$conn = null;

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $residentId < 1) {
        throw new RuntimeException('Invalid authenticated session.');
    }

    $lookup = $conn->prepare(
        'SELECT lost_report_id FROM pet_lost_recovery_reports
         WHERE id = :recovery_id LIMIT 1'
    );
    $lookup->execute([':recovery_id' => $recoveryId]);
    $lostReportId = $lookup->fetchColumn();
    if ($lostReportId === false) {
        sendRecoveryRescheduleResponse(404, [
            'success' => false,
            'message' => 'Recovery submission not found.'
        ]);
    }

    $conn->beginTransaction();

    $reportQuery = $conn->prepare(
        'SELECT id, user_id, report_type, status, deleted_at
         FROM pet_reports WHERE id = :report_id LIMIT 1 FOR UPDATE'
    );
    $reportQuery->execute([':report_id' => $lostReportId]);
    $report = $reportQuery->fetch(PDO::FETCH_ASSOC);
    if (!$report || $report['report_type'] !== 'lost') {
        failRecoveryReschedule($conn, 404, 'Recovery submission not found.');
    }

    $recoveryQuery = $conn->prepare(
        'SELECT id, lost_report_id, finder_user_id, status,
                pickup_location, pickup_latitude, pickup_longitude,
                pickup_date, pickup_time, pickup_timezone,
                pickup_confirmed_by_finder_at,
                owner_handover_confirmed_at, finder_handover_confirmed_at,
                completed_at
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id AND lost_report_id = :report_id
         LIMIT 1 FOR UPDATE'
    );
    $recoveryQuery->execute([
        ':recovery_id' => $recoveryId,
        ':report_id' => $lostReportId
    ]);
    $recovery = $recoveryQuery->fetch(PDO::FETCH_ASSOC);

    $ownerId = (int) $report['user_id'];
    $finderId = $recovery ? (int) $recovery['finder_user_id'] : 0;
    if (
        !$recovery || $ownerId === $finderId ||
        ($residentId !== $ownerId && $residentId !== $finderId)
    ) {
        failRecoveryReschedule($conn, 404, 'Recovery submission not found.');
    }

    if ($action === 'confirm_handover') {
        $isOwner = $residentId === $ownerId;

        $myColumn = $isOwner
            ? 'owner_handover_confirmed_at'
            : 'finder_handover_confirmed_at';
        $otherColumn = $isOwner
            ? 'finder_handover_confirmed_at'
            : 'owner_handover_confirmed_at';

        if (
            $recovery['status'] === 'completed' &&
            $recovery['completed_at'] !== null &&
            $recovery['owner_handover_confirmed_at'] !== null &&
            $recovery['finder_handover_confirmed_at'] !== null &&
            $report['status'] === 'resolved'
        ) {
            $conn->commit();
            sendRecoveryRescheduleResponse(200, [
                'success' => true,
                'message' => 'Both residents have already confirmed the pet return.',
                'action' => 'confirm_handover',
                'recovery_id' => $recoveryId,
                'lost_report_id' => (int) $lostReportId,
                'status' => 'completed',
                'lost_report_status' => 'resolved',
                'your_role' => $isOwner ? 'owner' : 'finder',
                'already_confirmed' => true,
                'owner_handover_confirmed_at' => $recovery['owner_handover_confirmed_at'],
                'finder_handover_confirmed_at' => $recovery['finder_handover_confirmed_at'],
                'completed_at' => $recovery['completed_at']
            ]);
        }

        // Preserve completed recovery history, but block new handover actions
        // after the parent Lost Pet report has been archived.
        if ($report['deleted_at'] !== null) {
            failRecoveryReschedule($conn, 409,
                'This Lost Pet report has been archived. Handover confirmation is no longer available.'
            );
        }

        if (!in_array(
            (string) $report['status'],
            ['pending', 'under_review', 'in_progress'],
            true
        )) {
            failRecoveryReschedule($conn, 409,
                'The Lost Pet report is no longer active. Refresh the recovery.'
            );
        }

        if ($recovery['status'] !== 'pickup_scheduled') {
            failRecoveryReschedule($conn, 409,
                $recovery['status'] === 'reschedule_requested'
                    ? 'Finish the pending reschedule before confirming handover.'
                    : 'This recovery is not ready for physical pet handover.'
            );
        }

        if (
            trim((string) $recovery['pickup_location']) === '' ||
            !$recovery['pickup_date'] || !$recovery['pickup_time'] ||
            $recovery['pickup_timezone'] !== 'Asia/Manila' ||
            $recovery['pickup_confirmed_by_finder_at'] === null
        ) {
            failRecoveryReschedule($conn, 409,
                'The finder must first confirm a complete, approved pickup arrangement.'
            );
        }

        $pendingHandoverReschedule = $conn->prepare(
            "SELECT id FROM pet_lost_recovery_reschedules
             WHERE recovery_id = :recovery_id AND status = 'pending'
             LIMIT 1"
        );
        $pendingHandoverReschedule->execute([':recovery_id' => $recoveryId]);
        if ($pendingHandoverReschedule->fetchColumn() !== false) {
            failRecoveryReschedule($conn, 409,
                'A reschedule is still pending. Resolve it before confirming handover.'
            );
        }

        $otherRecovery = $conn->prepare(
            "SELECT id FROM pet_lost_recovery_reports
             WHERE lost_report_id = :lost_report_id AND id <> :recovery_id
               AND status IN (
                 'approved', 'pickup_scheduled',
                 'reschedule_requested', 'disputed', 'completed'
               ) LIMIT 1"
        );
        $otherRecovery->execute([
            ':lost_report_id' => $lostReportId,
            ':recovery_id' => $recoveryId
        ]);
        if ($otherRecovery->fetchColumn() !== false) {
            failRecoveryReschedule($conn, 409,
                'Another recovery or dispute must be resolved before confirming handover.'
            );
        }

        if ($recovery[$myColumn] !== null) {
            $conn->commit();
            sendRecoveryRescheduleResponse(200, [
                'success' => true,
                'message' => 'Your handover confirmation was already recorded. Waiting for the other resident.',
                'action' => 'confirm_handover',
                'recovery_id' => $recoveryId,
                'lost_report_id' => (int) $lostReportId,
                'status' => 'pickup_scheduled',
                'lost_report_status' => (string) $report['status'],
                'your_role' => $isOwner ? 'owner' : 'finder',
                'already_confirmed' => true,
                'owner_handover_confirmed_at' => $recovery['owner_handover_confirmed_at'],
                'finder_handover_confirmed_at' => $recovery['finder_handover_confirmed_at'],
                'completed_at' => null
            ]);
        }

        if ($recovery[$otherColumn] === null) {

            $updateFirst = $conn->prepare(
                'UPDATE pet_lost_recovery_reports
                 SET ' . $myColumn . ' = NOW()
                 WHERE id = :recovery_id
                   AND status = \'pickup_scheduled\'
                   AND ' . $myColumn . ' IS NULL'
            );
            $updateFirst->execute([':recovery_id' => $recoveryId]);
            if ($updateFirst->rowCount() !== 1) {
                throw new RuntimeException('Handover confirmation changed unexpectedly.');
            }
            $saved = $conn->prepare(
                'SELECT owner_handover_confirmed_at,
                        finder_handover_confirmed_at
                 FROM pet_lost_recovery_reports WHERE id = :recovery_id'
            );
            $saved->execute([':recovery_id' => $recoveryId]);
            $timestamps = $saved->fetch(PDO::FETCH_ASSOC);
            if (!$timestamps) {
                throw new RuntimeException('Could not retrieve saved handover confirmation.');
            }

            $conn->commit();
            notifyRecoveryActionResident(
                $conn, $isOwner ? $finderId : $ownerId,
                'Pet Handover Confirmation',
                'The other resident confirmed the physical pet handover. Please confirm yours in My Recoveries.',
                'recovery_handover_confirmed', $recoveryId, (int) $lostReportId,
                'pickup_scheduled', $isOwner ? 'sent' : 'received'
            );
            sendRecoveryRescheduleResponse(200, [
                'success' => true,
                'message' => 'Your handover was recorded. Waiting for the other resident to confirm.',
                'action' => 'confirm_handover',
                'recovery_id' => $recoveryId,
                'lost_report_id' => (int) $lostReportId,
                'status' => 'pickup_scheduled',
                'lost_report_status' => (string) $report['status'],
                'your_role' => $isOwner ? 'owner' : 'finder',
                'already_confirmed' => false,
                'owner_handover_confirmed_at' => $timestamps['owner_handover_confirmed_at'],
                'finder_handover_confirmed_at' => $timestamps['finder_handover_confirmed_at'],
                'completed_at' => null
            ]);
        }

        $finish = $conn->prepare(
            'UPDATE pet_lost_recovery_reports
             SET ' . $myColumn . ' = NOW(),
                 status = \'completed\', completed_at = NOW()
             WHERE id = :recovery_id
               AND status = \'pickup_scheduled\'
               AND ' . $myColumn . ' IS NULL
               AND ' . $otherColumn . ' IS NOT NULL'
        );
        $finish->execute([':recovery_id' => $recoveryId]);
        if ($finish->rowCount() !== 1) {
            throw new RuntimeException('Recovery changed during final handover.');
        }

        $resolveLost = $conn->prepare(
            "UPDATE pet_reports
             SET status = 'resolved', updated_at = NOW()
             WHERE id = :report_id AND report_type = 'lost'
               AND deleted_at IS NULL
               AND status IN ('pending', 'under_review', 'in_progress')"
        );
        $resolveLost->execute([':report_id' => $lostReportId]);
        if ($resolveLost->rowCount() !== 1) {
            throw new RuntimeException('Lost Pet report changed during final handover.');
        }

        $closePending = $conn->prepare(
            "UPDATE pet_lost_recovery_reports
             SET status = 'cancelled',
                 cancellation_reason = 'Lost Pet returned following confirmed handover.',
                 cancelled_at = NOW()
             WHERE lost_report_id = :report_id AND id <> :recovery_id
               AND status = 'pending'"
        );
        $closePending->execute([
            ':report_id' => $lostReportId,
            ':recovery_id' => $recoveryId
        ]);

        $readFinished = $conn->prepare(
            'SELECT owner_handover_confirmed_at,
                    finder_handover_confirmed_at, completed_at
             FROM pet_lost_recovery_reports WHERE id = :recovery_id'
        );
        $readFinished->execute([':recovery_id' => $recoveryId]);
        $finished = $readFinished->fetch(PDO::FETCH_ASSOC);
        if (!$finished || !$finished['completed_at']) {
            throw new RuntimeException('Could not retrieve completed recovery.');
        }

        $conn->commit();
        // The other resident already confirmed first; notify them of completion.
        notifyRecoveryActionResident(
            $conn, $isOwner ? $finderId : $ownerId,
            'Lost Pet Recovery Completed',
            'Both residents confirmed the physical handover. The Lost Pet recovery is now completed.',
            'recovery_completed', $recoveryId, (int) $lostReportId,
            'completed', $isOwner ? 'sent' : 'received'
        );
        sendRecoveryRescheduleResponse(200, [
            'success' => true,
            'message' => 'Both residents confirmed the actual handover. The Lost Pet report is resolved.',
            'action' => 'confirm_handover',
            'recovery_id' => $recoveryId,
            'lost_report_id' => (int) $lostReportId,
            'status' => 'completed',
            'lost_report_status' => 'resolved',
            'your_role' => $isOwner ? 'owner' : 'finder',
            'already_confirmed' => false,
            'owner_handover_confirmed_at' => $finished['owner_handover_confirmed_at'],
            'finder_handover_confirmed_at' => $finished['finder_handover_confirmed_at'],
            'completed_at' => $finished['completed_at']
        ]);
    }

    // Archived Lost Pet reports are read-only: no pickup changes.
    if ($report['deleted_at'] !== null) {
        failRecoveryReschedule($conn, 409,
            'This Lost Pet report has been archived. Pickup rescheduling is no longer available.'
        );
    }

    if (!in_array((string) $report['status'], ['pending', 'under_review', 'in_progress'], true)) {
        failRecoveryReschedule($conn, 409, 'This Lost Pet report is no longer active.');
    }
    if (
        $recovery['owner_handover_confirmed_at'] !== null ||
        $recovery['finder_handover_confirmed_at'] !== null
    ) {
        failRecoveryReschedule($conn, 409,
            'Handover confirmation has already started; pickup can no longer change.'
        );
    }
    if (
        trim((string) $recovery['pickup_location']) === '' ||
        !$recovery['pickup_date'] || !$recovery['pickup_time'] ||
        (string) $recovery['pickup_timezone'] !== 'Asia/Manila'
    ) {
        failRecoveryReschedule($conn, 409,
            'The approved pickup arrangement is missing or invalid.'
        );
    }

    if ($action === 'request') {
        if ($recovery['status'] !== 'pickup_scheduled') {
            failRecoveryReschedule($conn, 409,
                $recovery['status'] === 'reschedule_requested'
                    ? 'A reschedule request is already awaiting a response.'
                    : 'A pickup must be approved before rescheduling.'
            );
        }

        $pendingQuery = $conn->prepare(
            "SELECT id FROM pet_lost_recovery_reschedules
             WHERE recovery_id = :recovery_id AND status = 'pending' LIMIT 1"
        );
        $pendingQuery->execute([':recovery_id' => $recoveryId]);
        if ($pendingQuery->fetchColumn() !== false) {
            failRecoveryReschedule($conn, 409, 'A pickup reschedule is already pending.');
        }

        $oldLocation = (string) $recovery['pickup_location'];
        $oldDate = (string) $recovery['pickup_date'];
        $oldTime = (string) $recovery['pickup_time'];
        $oldLat = $recovery['pickup_latitude'];
        $oldLng = $recovery['pickup_longitude'];

        $newLocation = $inputLocation ?? $oldLocation;
        $newDate = $inputDate ?? $oldDate;
        $newTime = $inputTime ?? $oldTime;
        if ($coordinatesSpecified) {
            $newLat = $inputLatitude;
            $newLng = $inputLongitude;
        } elseif ($newLocation !== $oldLocation) {

            $newLat = null;
            $newLng = null;
        } else {
            $newLat = $oldLat;
            $newLng = $oldLng;
        }

        if (!validFutureRecoveryPickup($newDate, $newTime)) {
            failRecoveryReschedule($conn, 422,
                'Choose a future pickup date/time (Asia/Manila).'
            );
        }
        if (
            $newLocation === $oldLocation && $newDate === $oldDate &&
            $newTime === $oldTime &&
            recoveryCoordEqual($oldLat, $newLat) &&
            recoveryCoordEqual($oldLng, $newLng)
        ) {
            failRecoveryReschedule($conn, 422,
                'Change at least one pickup detail before requesting a reschedule.'
            );
        }

        $create = $conn->prepare(
            "INSERT INTO pet_lost_recovery_reschedules (
                recovery_id, requested_by_user_id,
                previous_location, previous_latitude, previous_longitude,
                previous_date, previous_time,
                proposed_location, proposed_latitude, proposed_longitude,
                proposed_date, proposed_time, reason, status
             ) VALUES (
                :recovery_id, :requester_id,
                :previous_location, :previous_latitude, :previous_longitude,
                :previous_date, :previous_time,
                :proposed_location, :proposed_latitude, :proposed_longitude,
                :proposed_date, :proposed_time, :reason, 'pending'
             )"
        );
        $create->execute([
            ':recovery_id' => $recoveryId,
            ':requester_id' => $residentId,
            ':previous_location' => $oldLocation,
            ':previous_latitude' => $oldLat,
            ':previous_longitude' => $oldLng,
            ':previous_date' => $oldDate,
            ':previous_time' => $oldTime,
            ':proposed_location' => $newLocation,
            ':proposed_latitude' => $newLat,
            ':proposed_longitude' => $newLng,
            ':proposed_date' => $newDate,
            ':proposed_time' => $newTime,
            ':reason' => $reason
        ]);
        $newRescheduleId = (int) $conn->lastInsertId();

        $update = $conn->prepare(
            "UPDATE pet_lost_recovery_reports
             SET status = 'reschedule_requested'
             WHERE id = :recovery_id AND status = 'pickup_scheduled'"
        );
        $update->execute([':recovery_id' => $recoveryId]);
        if ($update->rowCount() !== 1) {
            throw new RuntimeException('Recovery status changed during reschedule request.');
        }

        $conn->commit();
        notifyRecoveryActionResident(
            $conn, $residentId === $ownerId ? $finderId : $ownerId,
            'Recovery Pickup Reschedule Requested',
            'The other resident requested a change to the pickup arrangement. Review it in My Recoveries.',
            'recovery_reschedule_requested', $recoveryId, (int) $lostReportId,
            'reschedule_requested', $residentId === $ownerId ? 'sent' : 'received'
        );
        sendRecoveryRescheduleResponse(201, [
            'success' => true,
            'message' => 'Reschedule requested. The other resident must accept or reject it.',
            'action' => 'request',
            'recovery_id' => $recoveryId,
            'lost_report_id' => (int) $lostReportId,
            'reschedule_id' => $newRescheduleId,
            'requested_by_user_id' => $residentId,
            'awaiting_user_id' => $residentId === $ownerId ? $finderId : $ownerId,
            'status' => 'reschedule_requested',
            'reschedule_status' => 'pending',
            'current_pickup' => recoveryPickupInfo(
                $oldLocation, $oldLat, $oldLng, $oldDate, $oldTime
            ),
            'proposed_pickup' => recoveryPickupInfo(
                $newLocation, $newLat, $newLng, $newDate, $newTime
            )
        ]);
    }

    if ($recovery['status'] !== 'reschedule_requested') {
        failRecoveryReschedule($conn, 409,
            'This recovery has no outstanding reschedule request.'
        );
    }

    $rescheduleQuery = $conn->prepare(
        'SELECT id, recovery_id, requested_by_user_id, status,
                previous_location, previous_latitude, previous_longitude,
                previous_date, previous_time,
                proposed_location, proposed_latitude, proposed_longitude,
                proposed_date, proposed_time
         FROM pet_lost_recovery_reschedules
         WHERE id = :reschedule_id AND recovery_id = :recovery_id
         LIMIT 1 FOR UPDATE'
    );
    $rescheduleQuery->execute([
        ':reschedule_id' => $rescheduleId,
        ':recovery_id' => $recoveryId
    ]);
    $proposal = $rescheduleQuery->fetch(PDO::FETCH_ASSOC);

    if (
        !$proposal ||
        !in_array((int) $proposal['requested_by_user_id'], [$ownerId, $finderId], true) ||
        (int) $proposal['requested_by_user_id'] === $residentId
    ) {
        failRecoveryReschedule($conn, 404,
            'Reschedule request not found or not assigned to you.'
        );
    }
    if ($proposal['status'] !== 'pending') {
        failRecoveryReschedule($conn, 409,
            'This reschedule request has already been handled.'
        );
    }

    if (
        (string) $proposal['previous_location'] !== (string) $recovery['pickup_location'] ||
        (string) $proposal['previous_date'] !== (string) $recovery['pickup_date'] ||
        (string) $proposal['previous_time'] !== (string) $recovery['pickup_time'] ||
        !recoveryCoordEqual($proposal['previous_latitude'], $recovery['pickup_latitude']) ||
        !recoveryCoordEqual($proposal['previous_longitude'], $recovery['pickup_longitude'])
    ) {
        failRecoveryReschedule($conn, 409,
            'The pickup schedule has changed. Please refresh before responding.'
        );
    }

    if ($action === 'accept') {
        if (
            trim((string) $proposal['proposed_location']) === '' ||
            ($proposal['proposed_latitude'] === null) !== ($proposal['proposed_longitude'] === null) ||
            !validFutureRecoveryPickup(
                (string) $proposal['proposed_date'],
                (string) $proposal['proposed_time']
            )
        ) {
            failRecoveryReschedule($conn, 422,
                'The proposed pickup is invalid or has passed. Request another future schedule.'
            );
        }
    }

    $updateProposal = $conn->prepare(
        "UPDATE pet_lost_recovery_reschedules
         SET status = :new_status, response_note = :response_note,
             responded_at = NOW()
         WHERE id = :reschedule_id AND recovery_id = :recovery_id
           AND status = 'pending'"
    );
    $updateProposal->execute([
        ':new_status' => $action === 'accept' ? 'accepted' : 'rejected',
        ':response_note' => $responseNote,
        ':reschedule_id' => $rescheduleId,
        ':recovery_id' => $recoveryId
    ]);
    if ($updateProposal->rowCount() !== 1) {
        throw new RuntimeException('Reschedule proposal was updated concurrently.');
    }

    if ($action === 'accept') {

        $updateRecovery = $conn->prepare(
            "UPDATE pet_lost_recovery_reports
             SET pickup_location = :pickup_location,
                 pickup_latitude = :pickup_latitude,
                 pickup_longitude = :pickup_longitude,
                 pickup_date = :pickup_date,
                 pickup_time = :pickup_time,
                 pickup_confirmed_by_finder_at = NULL,
                 status = 'pickup_scheduled'
             WHERE id = :recovery_id AND status = 'reschedule_requested'"
        );
        $updateRecovery->execute([
            ':pickup_location' => $proposal['proposed_location'],
            ':pickup_latitude' => $proposal['proposed_latitude'],
            ':pickup_longitude' => $proposal['proposed_longitude'],
            ':pickup_date' => $proposal['proposed_date'],
            ':pickup_time' => $proposal['proposed_time'],
            ':recovery_id' => $recoveryId
        ]);
    } else {

        $finderRequested = (int) $proposal['requested_by_user_id'] === $finderId;
        $updateRecovery = $conn->prepare(
            "UPDATE pet_lost_recovery_reports
             SET status = 'pickup_scheduled',
                 pickup_confirmed_by_finder_at = CASE
                     WHEN :clear_confirmation = 1 THEN NULL
                     ELSE pickup_confirmed_by_finder_at
                 END
             WHERE id = :recovery_id AND status = 'reschedule_requested'"
        );
        $updateRecovery->bindValue(':clear_confirmation', $finderRequested ? 1 : 0, PDO::PARAM_INT);
        $updateRecovery->bindValue(':recovery_id', $recoveryId, PDO::PARAM_INT);
        $updateRecovery->execute();
    }

    if ($updateRecovery->rowCount() !== 1) {
        throw new RuntimeException('Recovery pickup could not be updated.');
    }

    $conn->commit();
    notifyRecoveryActionResident(
        $conn, (int) $proposal['requested_by_user_id'],
        $action === 'accept' ? 'Recovery Reschedule Accepted' : 'Recovery Reschedule Rejected',
        $action === 'accept'
            ? 'Your proposed pickup change was accepted. The finder must confirm the new arrangement.'
            : 'Your proposed pickup change was rejected. The original arrangement remains in effect.',
        $action === 'accept' ? 'recovery_reschedule_accepted' : 'recovery_reschedule_rejected',
        $recoveryId, (int) $lostReportId, 'pickup_scheduled',
        (int) $proposal['requested_by_user_id'] === $ownerId ? 'received' : 'sent'
    );

    $accepted = $action === 'accept';
    $requiresFinderConfirmation = $accepted ||
        (int) $proposal['requested_by_user_id'] === $finderId ||
        $recovery['pickup_confirmed_by_finder_at'] === null;

    sendRecoveryRescheduleResponse(200, [
        'success' => true,
        'message' => $accepted
            ? 'Reschedule accepted. The finder must confirm the new pickup arrangement.'
            : 'Reschedule rejected. The original pickup arrangement remains in effect.',
        'action' => $action,
        'recovery_id' => $recoveryId,
        'lost_report_id' => (int) $lostReportId,
        'reschedule_id' => $rescheduleId,
        'status' => 'pickup_scheduled',
        'reschedule_status' => $accepted ? 'accepted' : 'rejected',
        'pickup_confirmation_required' => $requiresFinderConfirmation,
        'pickup' => $accepted
            ? recoveryPickupInfo(
                (string) $proposal['proposed_location'],
                $proposal['proposed_latitude'],
                $proposal['proposed_longitude'],
                (string) $proposal['proposed_date'],
                (string) $proposal['proposed_time']
            )
            : recoveryPickupInfo(
                (string) $recovery['pickup_location'],
                $recovery['pickup_latitude'],
                $recovery['pickup_longitude'],
                (string) $recovery['pickup_date'],
                (string) $recovery['pickup_time']
            )
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawConnect Lost Pet Recovery Management] ' . $e->getMessage());
    sendRecoveryRescheduleResponse(500, [
        'success' => false,
        'message' => 'Unable to process the recovery action. Please try again.'
    ]);
}
