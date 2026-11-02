<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendRescheduleDecisionResponse(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ============================================================
// BEST-EFFORT FCM NOTIFICATION FOR A PICKUP RESCHEDULE DECISION
// ============================================================
// The recipient is derived from the authorized, saved reschedule
// record, not from client input. Called only AFTER the DB commit.
// One active Android registration is selected for that resident;
// browser-only accounts can still check their claim in PawRescue.
function notifyOwnershipRescheduleDecision(
    PDO $conn,
    int $recipientId,
    int $claimId,
    int $foundReportId,
    int $rescheduleId,
    string $action
): void {
    if (
        $recipientId <= 0 || $claimId <= 0 || $foundReportId <= 0 ||
        $rescheduleId <= 0 || !in_array($action, ['accept', 'reject'], true)
    ) {
        return;
    }

    try {
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

        if (
            !is_array($device) ||
            !is_string($device['device_token'] ?? null) ||
            $device['device_token'] === ''
        ) {
            return;
        }

        require_once __DIR__ . '/../push_notifications/fcm_sender.php';

        $accepted = $action === 'accept';
        $result = pawrescueSendFcmToToken(
            $device['device_token'],
            $accepted ? 'Pickup Reschedule Accepted' : 'Pickup Reschedule Rejected',
            $accepted
                ? 'Your pickup reschedule was accepted. Open PawRescue to review the updated arrangement.'
                : 'Your pickup reschedule was rejected. The previous arrangement remains in place. Open PawRescue to review it.',
            [
                'type' => $accepted
                    ? 'ownership_reschedule_accepted'
                    : 'ownership_reschedule_rejected',
                'claim_id' => (string) $claimId,
                'found_report_id' => (string) $foundReportId,
                'reschedule_id' => (string) $rescheduleId,
                'status' => 'pickup_scheduled',
                'reschedule_status' => $accepted ? 'accepted' : 'rejected'
            ]
        );

        if (($result['unregistered'] ?? false) === true) {
            // Disable only this registration. Account/device ownership
            // might have changed between selection and FCM response.
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
            // Never include device tokens or private claim details in logs.
            error_log('[PawRescue Reschedule Decision Push] Firebase did not accept the notice.');
        }
    } catch (Throwable $pushError) {
        // An FCM error cannot undo the committed reschedule decision.
        error_log(
            '[PawRescue Reschedule Decision Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

// ============================================================
// METHOD AND REQUEST VALIDATION
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRescheduleDecisionResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    sendRescheduleDecisionResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

$raw = file_get_contents('php://input', false, null, 0, 8193);
if ($raw === false || strlen($raw) > 8192) {
    sendRescheduleDecisionResponse(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$data = json_decode($raw, true);
if (!is_array($data) || array_is_list($data)) {
    sendRescheduleDecisionResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

// Strict positive integer IDs; do not accept booleans/floats.
function requiredPositiveRescheduleId(array $data, string $field): int
{
    $value = $data[$field] ?? null;
    if (
        !(is_int($value) || is_string($value)) ||
        !preg_match('/^[1-9][0-9]*$/D', (string) $value)
    ) {
        sendRescheduleDecisionResponse(400, [
            'success' => false,
            'message' => 'A valid ' . $field . ' is required.'
        ]);
    }

    $id = filter_var($value, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1]
    ]);
    if ($id === false) {
        sendRescheduleDecisionResponse(400, [
            'success' => false,
            'message' => 'A valid ' . $field . ' is required.'
        ]);
    }
    return (int) $id;
}

$claimId = requiredPositiveRescheduleId($data, 'claim_id');
$rescheduleId = requiredPositiveRescheduleId($data, 'reschedule_id');
$action = $data['action'] ?? null;

if (!is_string($action) || !in_array($action, ['accept', 'reject'], true)) {
    sendRescheduleDecisionResponse(400, [
        'success' => false,
        'message' => 'Action must be accept or reject.'
    ]);
}

$responseNote = null;
if (array_key_exists('response_note', $data)) {
    if ($data['response_note'] !== null && !is_string($data['response_note'])) {
        sendRescheduleDecisionResponse(422, [
            'success' => false,
            'message' => 'Invalid response note.'
        ]);
    }
    if (is_string($data['response_note'])) {
        $responseNote = trim($data['response_note']);
        if (mb_strlen($responseNote, 'UTF-8') > 1000) {
            sendRescheduleDecisionResponse(422, [
                'success' => false,
                'message' => 'Response note must not exceed 1000 characters.'
            ]);
        }
        if ($responseNote === '') {
            $responseNote = null;
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

    // Preliminary ID lookup is ONLY for consistent locking order.
    // Access is authorized after the report, claim and request
    // are loaded inside the transaction.
    $lookup = $conn->prepare(
        'SELECT found_report_id
         FROM pet_ownership_claims
         WHERE id = :claim_id LIMIT 1'
    );
    $lookup->execute([':claim_id' => $claimId]);
    $foundReportId = $lookup->fetchColumn();

    if ($foundReportId === false) {
        sendRescheduleDecisionResponse(404, [
            'success' => false,
            'message' => 'Reschedule request not found.'
        ]);
    }

    $conn->beginTransaction();

    // Lock order: pet_reports -> pet_ownership_claims ->
    // pet_ownership_pickup_reschedules. Matches Steps 7 and 8.
    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :report_id LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':report_id' => $foundReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (!$report || $report['report_type'] !== 'found') {
        $conn->rollBack();
        sendRescheduleDecisionResponse(404, [
            'success' => false,
            'message' => 'Reschedule request not found.'
        ]);
    }

    $claimStmt = $conn->prepare(
        'SELECT id, found_report_id, claimant_user_id, status,
                pickup_location, pickup_latitude, pickup_longitude,
                pickup_date, pickup_time, pickup_timezone,
                pickup_confirmed_by_claimant_at,
                finder_handover_confirmed_at, claimant_handover_confirmed_at
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

    // Do not reveal private claims to nonparticipants.
    if (
        !$claim || $finderId === $claimantId ||
        ($residentId !== $finderId && $residentId !== $claimantId)
    ) {
        $conn->rollBack();
        sendRescheduleDecisionResponse(404, [
            'success' => false,
            'message' => 'Reschedule request not found.'
        ]);
    }

    $rescheduleStmt = $conn->prepare(
        'SELECT id, claim_id, requested_by_user_id,
                previous_location, previous_latitude, previous_longitude,
                previous_date, previous_time,
                proposed_location, proposed_latitude, proposed_longitude,
                proposed_date, proposed_time, status
         FROM pet_ownership_pickup_reschedules
         WHERE id = :reschedule_id AND claim_id = :claim_id
         LIMIT 1 FOR UPDATE'
    );
    $rescheduleStmt->execute([
        ':reschedule_id' => $rescheduleId,
        ':claim_id' => $claimId
    ]);
    $reschedule = $rescheduleStmt->fetch(PDO::FETCH_ASSOC);

    // Only the OTHER participant may respond.
    if (
        !$reschedule ||
        (int) $reschedule['requested_by_user_id'] === $residentId ||
        !in_array((int) $reschedule['requested_by_user_id'], [$finderId, $claimantId], true)
    ) {
        $conn->rollBack();
        sendRescheduleDecisionResponse(404, [
            'success' => false,
            'message' => 'Reschedule request not found or not assigned to you.'
        ]);
    }

    if (!in_array((string) $report['status'],
        ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        sendRescheduleDecisionResponse(409, [
            'success' => false,
            'message' => 'The Found Pet report is no longer active.'
        ]);
    }

    if ($claim['status'] !== 'reschedule_requested' || $reschedule['status'] !== 'pending') {
        $conn->rollBack();
        sendRescheduleDecisionResponse(409, [
            'success' => false,
            'message' => 'This reschedule request is no longer awaiting a response.',
            'claim_status' => (string) $claim['status'],
            'reschedule_status' => (string) $reschedule['status']
        ]);
    }

    if ($claim['finder_handover_confirmed_at'] !== null ||
        $claim['claimant_handover_confirmed_at'] !== null) {
        $conn->rollBack();
        sendRescheduleDecisionResponse(409, [
            'success' => false,
            'message' => 'Pet handover confirmation has already started.'
        ]);
    }

    if (!$claim['pickup_location'] || !$claim['pickup_date'] || !$claim['pickup_time'] ||
        (string) $claim['pickup_timezone'] !== 'Asia/Manila') {
        $conn->rollBack();
        sendRescheduleDecisionResponse(409, [
            'success' => false,
            'message' => 'The current pickup arrangement is incomplete.'
        ]);
    }

    // Detect stale proposals: the approved pickup must still be
    // the same pickup that was recorded when Step 8 requested
    // this change. Decimal values may be returned as strings.
    $sameCoord = static function ($a, $b): bool {
        if ($a === null || $b === null) {
            return $a === null && $b === null;
        }
        return is_numeric($a) && is_numeric($b) &&
            round((float) $a, 8) === round((float) $b, 8);
    };

    if (
        (string) $claim['pickup_location'] !== (string) $reschedule['previous_location'] ||
        (string) $claim['pickup_date'] !== (string) $reschedule['previous_date'] ||
        (string) $claim['pickup_time'] !== (string) $reschedule['previous_time'] ||
        !$sameCoord($claim['pickup_latitude'], $reschedule['previous_latitude']) ||
        !$sameCoord($claim['pickup_longitude'], $reschedule['previous_longitude'])
    ) {
        $conn->rollBack();
        sendRescheduleDecisionResponse(409, [
            'success' => false,
            'message' => 'The existing pickup arrangement has changed. Refresh the claim before responding.'
        ]);
    }

    if ($action === 'accept') {
        // An accepted pickup must still be in the future.
        $manila = new DateTimeZone('Asia/Manila');
        $proposedAt = DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i:s',
            (string) $reschedule['proposed_date'] . ' ' . (string) $reschedule['proposed_time'],
            $manila
        );

        if (!$proposedAt || $proposedAt <= new DateTimeImmutable('now', $manila)) {
            $conn->rollBack();
            sendRescheduleDecisionResponse(422, [
                'success' => false,
                'message' => 'The proposed pickup time has passed. Ask the other resident to propose a future schedule.'
            ]);
        }

        if (
            !is_string($reschedule['proposed_location']) ||
            trim($reschedule['proposed_location']) === '' ||
            (($reschedule['proposed_latitude'] === null) !==
             ($reschedule['proposed_longitude'] === null))
        ) {
            throw new RuntimeException('Invalid stored proposed pickup arrangement.');
        }
    }

    // Store the response before changing the parent claim, all
    // within one transaction: either everything succeeds or none.
    $rescheduleUpdate = $conn->prepare(
        'UPDATE pet_ownership_pickup_reschedules
         SET status = :status, response_note = :response_note,
             responded_at = NOW()
         WHERE id = :reschedule_id AND claim_id = :claim_id
           AND status = \'pending\''
    );
    $rescheduleUpdate->execute([
        ':status' => $action === 'accept' ? 'accepted' : 'rejected',
        ':response_note' => $responseNote,
        ':reschedule_id' => $rescheduleId,
        ':claim_id' => $claimId
    ]);

    if ($rescheduleUpdate->rowCount() !== 1) {
        throw new RuntimeException('Reschedule status changed unexpectedly.');
    }

    if ($action === 'accept') {
        // Save the newly AGREED pickup. Resident B must confirm
        // this updated schedule via confirm_pickup.php.
        $claimUpdate = $conn->prepare(
            'UPDATE pet_ownership_claims
             SET pickup_location = :location,
                 pickup_latitude = :latitude,
                 pickup_longitude = :longitude,
                 pickup_date = :pickup_date,
                 pickup_time = :pickup_time,
                 pickup_confirmed_by_claimant_at = NULL,
                 status = \'pickup_scheduled\'
             WHERE id = :claim_id AND status = \'reschedule_requested\''
        );
        $claimUpdate->execute([
            ':location' => $reschedule['proposed_location'],
            ':latitude' => $reschedule['proposed_latitude'],
            ':longitude' => $reschedule['proposed_longitude'],
            ':pickup_date' => $reschedule['proposed_date'],
            ':pickup_time' => $reschedule['proposed_time'],
            ':claim_id' => $claimId
        ]);
    } else {
        // REJECT: preserve the original pickup. If B requested a
        // change, any earlier B confirmation is no longer reliable;
        // ask B to reconfirm the original arrangement.
        $resetClaimantConfirmation = (int) $reschedule['requested_by_user_id'] === $claimantId;
        $claimUpdate = $conn->prepare(
            'UPDATE pet_ownership_claims
             SET status = \'pickup_scheduled\',
                 pickup_confirmed_by_claimant_at = CASE
                     WHEN :reset_confirmation = 1 THEN NULL
                     ELSE pickup_confirmed_by_claimant_at
                 END
             WHERE id = :claim_id AND status = \'reschedule_requested\''
        );
        $claimUpdate->bindValue(':reset_confirmation', $resetClaimantConfirmation ? 1 : 0, PDO::PARAM_INT);
        $claimUpdate->bindValue(':claim_id', $claimId, PDO::PARAM_INT);
        $claimUpdate->execute();
    }

    if ($claimUpdate->rowCount() !== 1) {
        throw new RuntimeException('Claim status changed while responding to the reschedule.');
    }

    $conn->commit();

    $accepted = $action === 'accept';
    $location = $accepted
        ? (string) $reschedule['proposed_location']
        : (string) $claim['pickup_location'];
    $latitude = $accepted ? $reschedule['proposed_latitude'] : $claim['pickup_latitude'];
    $longitude = $accepted ? $reschedule['proposed_longitude'] : $claim['pickup_longitude'];
    $date = $accepted
        ? (string) $reschedule['proposed_date']
        : (string) $claim['pickup_date'];
    $time = $accepted
        ? (string) $reschedule['proposed_time']
        : (string) $claim['pickup_time'];

    $confirmationRequired = $accepted ||
        (int) $reschedule['requested_by_user_id'] === $claimantId ||
        $claim['pickup_confirmed_by_claimant_at'] === null;

    // Notify only the resident who requested this change, not the
    // person who just responded. A repeated decision is blocked by
    // the pending-state checks above and will not resend a push.
    // Notification delivery is best-effort and runs after commit.
    notifyOwnershipRescheduleDecision(
        $conn,
        (int) $reschedule['requested_by_user_id'],
        $claimId,
        (int) $foundReportId,
        $rescheduleId,
        $action
    );

    sendRescheduleDecisionResponse(200, [
        'success' => true,
        'message' => $accepted
            ? 'Reschedule accepted. The claimant must confirm the updated pickup arrangement.'
            : 'Reschedule rejected. The previous pickup arrangement remains in place.',
        'claim_id' => $claimId,
        'reschedule_id' => $rescheduleId,
        'found_report_id' => (int) $foundReportId,
        'status' => 'pickup_scheduled',
        'reschedule_status' => $accepted ? 'accepted' : 'rejected',
        'pickup_confirmation_required' => $confirmationRequired,
        'pickup' => [
            'location' => $location,
            'latitude' => $latitude === null ? null : (float) $latitude,
            'longitude' => $longitude === null ? null : (float) $longitude,
            'date' => $date,
            'time' => $time,
            'timezone' => 'Asia/Manila'
        ]
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Ownership Reschedule Response] ' . $e->getMessage());
    sendRescheduleDecisionResponse(500, [
        'success' => false,
        'message' => 'Unable to respond to the pickup reschedule. Please try again.'
    ]);
}
