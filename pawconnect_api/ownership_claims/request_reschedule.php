<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendRescheduleResponse(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ============================================================
// NOTIFY THE OTHER RESIDENT OF A NEW PICKUP RESCHEDULE REQUEST
// ============================================================
// Notify only the other participant: finder -> claimant or
// claimant -> finder. IDs come from authenticated claim records.
// Call AFTER committing the transaction, never while locks are held.
// Push is best-effort and cannot undo an already-saved request.
function notifyOwnershipRescheduleRequested(
    PDO $conn,
    int $recipientId,
    int $claimId,
    int $foundReportId,
    int $rescheduleId
): void {
    if ($recipientId <= 0 || $claimId <= 0 || $foundReportId <= 0 || $rescheduleId <= 0) {
        return;
    }

    try {
        // Select one currently active Android token owned by the
        // specific recipient. Do not notify unrelated residents.
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

        if (!is_array($device) ||
            !is_string($device['device_token'] ?? null) ||
            $device['device_token'] === '') {
            // Browser-only accounts don't have Android FCM tokens;
            // they can still view the request in the authenticated app.
            return;
        }

        require_once __DIR__ . '/../push_notifications/fcm_sender.php';

        $result = pawrescueSendFcmToToken(
            $device['device_token'],
            'Pickup Reschedule Requested',
            'The other resident requested a change to your pet pickup arrangement. Open PawRescue to review it.',
            [
                'type' => 'ownership_reschedule_requested',
                'claim_id' => (string) $claimId,
                'found_report_id' => (string) $foundReportId,
                'reschedule_id' => (string) $rescheduleId,
                'status' => 'reschedule_requested'
            ]
        );

        if (($result['unregistered'] ?? false) === true) {
            // A dead token can be disabled without changing the
            // registration of any other user or reassigned token.
            $disableStmt = $conn->prepare(
                'UPDATE user_push_tokens
                 SET is_active = 0, updated_at = NOW()
                 WHERE id = :token_id
                   AND user_id = :recipient_id
                   AND device_token = :device_token
                   AND platform = :platform
                   AND is_active = 1'
            );
            $disableStmt->execute([
                ':token_id' => (int) $device['id'],
                ':recipient_id' => $recipientId,
                ':device_token' => $device['device_token'],
                ':platform' => 'android'
            ]);
        }

        if (($result['success'] ?? false) !== true) {
            // No tokens, credentials or private pickup details in logs.
            error_log('[PawRescue Ownership Reschedule Push] Firebase did not accept the notice.');
        }
    } catch (Throwable $pushError) {
        // The reschedule request is already committed. Sending a push
        // must not change this API response into a failure.
        error_log(
            '[PawRescue Ownership Reschedule Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRescheduleResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    sendRescheduleResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// Small JSON input only; evidence uploads use a different route.
$raw = file_get_contents('php://input', false, null, 0, 8193);
if ($raw === false || strlen($raw) > 8192) {
    sendRescheduleResponse(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$data = json_decode($raw, true);
if (!is_array($data) || array_is_list($data)) {
    sendRescheduleResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$claimId = filter_var(
    $data['claim_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);
if ($claimId === false || $claimId === null) {
    sendRescheduleResponse(400, [
        'success' => false,
        'message' => 'A valid claim ID is required.'
    ]);
}

// Validate supplied values BEFORE opening a database transaction.
// Missing values mean "keep the current approved value".
$locationInput = null;
if (array_key_exists('pickup_location', $data)) {
    if (!is_string($data['pickup_location'])) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Invalid proposed pickup location.'
        ]);
    }
    $locationInput = trim($data['pickup_location']);
    if (
        strlen($locationInput) < 5 || strlen($locationInput) > 255 ||
        preg_match('/[\x00-\x1F\x7F]/', $locationInput)
    ) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Pickup location must be one line, 5 to 255 bytes.'
        ]);
    }
}

$dateInput = null;
if (array_key_exists('pickup_date', $data)) {
    $dateInput = $data['pickup_date'];
    if (!is_string($dateInput) ||
        !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $dateInput)) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Use a valid pickup date (YYYY-MM-DD).'
        ]);
    }
    [$y, $m, $d] = array_map('intval', explode('-', $dateInput));
    if (!checkdate($m, $d, $y)) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'The proposed pickup date does not exist.'
        ]);
    }
}

$timeInput = null;
if (array_key_exists('pickup_time', $data)) {
    $timeInput = $data['pickup_time'];
    if (!is_string($timeInput) ||
        !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/D', $timeInput)) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Use a valid pickup time (HH:MM).'
        ]);
    }
    if (strlen($timeInput) === 5) {
        $timeInput .= ':00';
    }
}

$coordinateFieldsPresent = array_key_exists('pickup_latitude', $data) ||
    array_key_exists('pickup_longitude', $data);
$inputLatitude = $data['pickup_latitude'] ?? null;
$inputLongitude = $data['pickup_longitude'] ?? null;
if ($coordinateFieldsPresent) {
    if (!array_key_exists('pickup_latitude', $data) ||
        !array_key_exists('pickup_longitude', $data) ||
        (($inputLatitude === null) !== ($inputLongitude === null))) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Provide both pickup coordinates or set both to null.'
        ]);
    }

    if ($inputLatitude !== null) {
        if (
            (!is_float($inputLatitude) && !is_int($inputLatitude) && !is_string($inputLatitude)) ||
            (!is_float($inputLongitude) && !is_int($inputLongitude) && !is_string($inputLongitude)) ||
            !is_numeric($inputLatitude) || !is_numeric($inputLongitude) ||
            !is_finite((float) $inputLatitude) || !is_finite((float) $inputLongitude) ||
            (float) $inputLatitude < -90 || (float) $inputLatitude > 90 ||
            (float) $inputLongitude < -180 || (float) $inputLongitude > 180
        ) {
            sendRescheduleResponse(422, [
                'success' => false,
                'message' => 'Invalid proposed pickup coordinates.'
            ]);
        }
        $inputLatitude = (float) $inputLatitude;
        $inputLongitude = (float) $inputLongitude;
    }
}

$reason = null;
if (array_key_exists('reason', $data)) {
    if ($data['reason'] !== null && !is_string($data['reason'])) {
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Invalid reschedule reason.'
        ]);
    }
    if (is_string($data['reason'])) {
        $reason = trim($data['reason']);
        if (mb_strlen($reason, 'UTF-8') > 1000) {
            sendRescheduleResponse(422, [
                'success' => false,
                'message' => 'Reason must not exceed 1000 characters.'
            ]);
        }
        if ($reason === '') {
            $reason = null;
        }
    }
}

require_once __DIR__ . '/../middleware/auth_middleware.php';
$conn = null;

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);
    if (!($conn instanceof PDO) || $residentId <= 0) {
        throw new RuntimeException('Invalid authentication context.');
    }

    // Lock order shared with approval and pickup confirmation:
    // parent pet_reports row -> claim row -> reschedule records.
    // This preliminary lookup is not authorization.
    $lookup = $conn->prepare(
        'SELECT found_report_id FROM pet_ownership_claims
         WHERE id = :claim_id LIMIT 1'
    );
    $lookup->execute([':claim_id' => $claimId]);
    $foundReportId = $lookup->fetchColumn();
    if ($foundReportId === false) {
        sendRescheduleResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $conn->beginTransaction();

    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports WHERE id = :report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':report_id' => $foundReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);
    if (!$report || $report['report_type'] !== 'found') {
        $conn->rollBack();
        sendRescheduleResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $claimStmt = $conn->prepare(
        'SELECT id, found_report_id, claimant_user_id, status,
                pickup_location, pickup_latitude, pickup_longitude,
                pickup_date, pickup_time, pickup_timezone,
                finder_handover_confirmed_at,
                claimant_handover_confirmed_at
         FROM pet_ownership_claims
         WHERE id = :claim_id AND found_report_id = :report_id
         LIMIT 1 FOR UPDATE'
    );
    $claimStmt->execute([
        ':claim_id' => $claimId,
        ':report_id' => $foundReportId
    ]);
    $claim = $claimStmt->fetch(PDO::FETCH_ASSOC);

    $finderId = (int) $report['user_id'];
    $claimantId = $claim ? (int) $claim['claimant_user_id'] : 0;
    if (
        !$claim || $finderId === $claimantId ||
        ($residentId !== $finderId && $residentId !== $claimantId)
    ) {
        $conn->rollBack();
        // Do not reveal another resident's private claim.
        sendRescheduleResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    if (!in_array((string) $report['status'],
        ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        sendRescheduleResponse(409, [
            'success' => false,
            'message' => 'This Found Pet report is no longer active.'
        ]);
    }

    if ((string) $claim['status'] !== 'pickup_scheduled') {
        $conn->rollBack();
        sendRescheduleResponse(409, [
            'success' => false,
            'message' => $claim['status'] === 'reschedule_requested'
                ? 'A reschedule request is already pending a response.'
                : 'A pickup arrangement must be approved before rescheduling.',
            'status' => (string) $claim['status']
        ]);
    }

    if ($claim['finder_handover_confirmed_at'] !== null ||
        $claim['claimant_handover_confirmed_at'] !== null) {
        $conn->rollBack();
        sendRescheduleResponse(409, [
            'success' => false,
            'message' => 'The handover confirmation process has started. Contact the other participant before changing pickup plans.'
        ]);
    }

    if (!$claim['pickup_location'] || !$claim['pickup_date'] || !$claim['pickup_time'] ||
        (string) $claim['pickup_timezone'] !== 'Asia/Manila') {
        $conn->rollBack();
        sendRescheduleResponse(409, [
            'success' => false,
            'message' => 'The existing pickup arrangement is incomplete.'
        ]);
    }

    // The report lock serializes concurrent requests for this claim,
    // but also check the reschedule table to catch stale or legacy states.
    $pendingStmt = $conn->prepare(
        "SELECT id FROM pet_ownership_pickup_reschedules
         WHERE claim_id = :claim_id AND status = 'pending'
         LIMIT 1"
    );
    $pendingStmt->execute([':claim_id' => $claimId]);
    if ($pendingStmt->fetchColumn() !== false) {
        $conn->rollBack();
        sendRescheduleResponse(409, [
            'success' => false,
            'message' => 'A reschedule request is already pending.'
        ]);
    }

    $previousLocation = (string) $claim['pickup_location'];
    $previousLatitude = $claim['pickup_latitude'] === null
        ? null : (float) $claim['pickup_latitude'];
    $previousLongitude = $claim['pickup_longitude'] === null
        ? null : (float) $claim['pickup_longitude'];
    $previousDate = (string) $claim['pickup_date'];
    $previousTime = (string) $claim['pickup_time'];

    $proposedLocation = $locationInput ?? $previousLocation;
    $proposedDate = $dateInput ?? $previousDate;
    $proposedTime = $timeInput ?? $previousTime;

    if ($coordinateFieldsPresent) {
        $proposedLatitude = $inputLatitude;
        $proposedLongitude = $inputLongitude;
    } elseif ($proposedLocation !== $previousLocation) {
        // A new place cannot retain the old place's GPS pin.
        $proposedLatitude = null;
        $proposedLongitude = null;
    } else {
        $proposedLatitude = $previousLatitude;
        $proposedLongitude = $previousLongitude;
    }

    $localTime = DateTimeImmutable::createFromFormat(
        '!Y-m-d H:i:s',
        $proposedDate . ' ' . $proposedTime,
        new DateTimeZone('Asia/Manila')
    );
    if (!$localTime || $localTime <= new DateTimeImmutable('now', new DateTimeZone('Asia/Manila'))) {
        $conn->rollBack();
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Proposed pickup date and time must be in the future (Philippine time).'
        ]);
    }

    $sameLatitude = ($previousLatitude === null && $proposedLatitude === null) ||
        ($previousLatitude !== null && $proposedLatitude !== null &&
         round($previousLatitude, 8) === round((float) $proposedLatitude, 8));
    $sameLongitude = ($previousLongitude === null && $proposedLongitude === null) ||
        ($previousLongitude !== null && $proposedLongitude !== null &&
         round($previousLongitude, 8) === round((float) $proposedLongitude, 8));
    if (
        $proposedLocation === $previousLocation &&
        $proposedDate === $previousDate &&
        $proposedTime === $previousTime &&
        $sameLatitude && $sameLongitude
    ) {
        $conn->rollBack();
        sendRescheduleResponse(422, [
            'success' => false,
            'message' => 'Please change the pickup location, date, or time before requesting rescheduling.'
        ]);
    }

    // Store a permanent history entry; the agreed pickup in
    // pet_ownership_claims remains unchanged until Step 9 ACCEPT.
    $insert = $conn->prepare(
        "INSERT INTO pet_ownership_pickup_reschedules (
            claim_id, requested_by_user_id,
            previous_location, previous_latitude, previous_longitude,
            previous_date, previous_time,
            proposed_location, proposed_latitude, proposed_longitude,
            proposed_date, proposed_time, reason, status
        ) VALUES (
            :claim_id, :requester_id,
            :previous_location, :previous_latitude, :previous_longitude,
            :previous_date, :previous_time,
            :proposed_location, :proposed_latitude, :proposed_longitude,
            :proposed_date, :proposed_time, :reason, 'pending'
        )"
    );
    $insert->execute([
        ':claim_id' => $claimId,
        ':requester_id' => $residentId,
        ':previous_location' => $previousLocation,
        ':previous_latitude' => $previousLatitude,
        ':previous_longitude' => $previousLongitude,
        ':previous_date' => $previousDate,
        ':previous_time' => $previousTime,
        ':proposed_location' => $proposedLocation,
        ':proposed_latitude' => $proposedLatitude,
        ':proposed_longitude' => $proposedLongitude,
        ':proposed_date' => $proposedDate,
        ':proposed_time' => $proposedTime,
        ':reason' => $reason
    ]);
    $rescheduleId = (int) $conn->lastInsertId();

    $update = $conn->prepare(
        "UPDATE pet_ownership_claims
         SET status = 'reschedule_requested'
         WHERE id = :claim_id AND status = 'pickup_scheduled'"
    );
    $update->execute([':claim_id' => $claimId]);
    if ($update->rowCount() !== 1) {
        throw new RuntimeException('Claim status changed during rescheduling.');
    }

    $conn->commit();

    // Only a newly submitted, successfully committed reschedule
    // generates a push. Rejected/duplicate requests exit earlier.
    // Notify the opposite participant, not the requester.
    $awaitingUserId = $residentId === $finderId ? $claimantId : $finderId;
    notifyOwnershipRescheduleRequested(
        $conn,
        $awaitingUserId,
        $claimId,
        (int) $foundReportId,
        $rescheduleId
    );

    sendRescheduleResponse(201, [
        'success' => true,
        'message' => 'Reschedule request submitted. The other resident must review it before the pickup changes.',
        'claim_id' => $claimId,
        'found_report_id' => (int) $foundReportId,
        'reschedule_id' => $rescheduleId,
        'requested_by_user_id' => $residentId,
        'awaiting_user_id' => $awaitingUserId,
        'status' => 'reschedule_requested',
        'reschedule_status' => 'pending',
        'proposed_pickup' => [
            'location' => $proposedLocation,
            'latitude' => $proposedLatitude,
            'longitude' => $proposedLongitude,
            'date' => $proposedDate,
            'time' => $proposedTime,
            'timezone' => 'Asia/Manila'
        ]
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Ownership Reschedule Request] ' . $e->getMessage());
    sendRescheduleResponse(500, [
        'success' => false,
        'message' => 'Unable to request a pickup reschedule. Please try again.'
    ]);
}
