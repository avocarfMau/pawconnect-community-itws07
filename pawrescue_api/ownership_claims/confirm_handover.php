<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function respondHandover(int $statusCode, array $body): void
{
    http_response_code($statusCode);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ============================================================
// BEST-EFFORT FCM NOTIFICATIONS FOR OWNERSHIP HANDOVER
// ============================================================
// Only the OTHER verified participant is notified. The recipient
// is derived from the stored claim and Found Pet report, never
// from client input. Call only AFTER the DB transaction commits.
// A browser-only participant can still check the claim status.
function notifyOwnershipHandoverParticipant(
    PDO $conn,
    int $recipientId,
    int $claimId,
    int $foundReportId,
    string $event,
    bool $confirmedByFinder
): void {
    if (
        $recipientId <= 0 || $claimId <= 0 || $foundReportId <= 0 ||
        !in_array($event, ['first_confirmed', 'completed'], true)
    ) {
        return;
    }

    try {
        // Select only the intended resident's latest active Android token.
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

        $completed = $event === 'completed';
        $actor = $confirmedByFinder ? 'finder' : 'claimant';
        $title = $completed
            ? 'Pet Handover Completed'
            : 'Pet Handover Confirmation';
        $body = $completed
            ? 'Both residents have confirmed the pet handover. The Found Pet report is now resolved.'
            : ($confirmedByFinder
                ? 'The finder confirmed the pet handover. Please confirm in PawRescue only if the pet was actually handed over.'
                : 'The claimant confirmed the pet handover. Please confirm in PawRescue only if the pet was actually handed over.');

        $result = pawrescueSendFcmToToken(
            $device['device_token'],
            $title,
            $body,
            [
                'type' => $completed
                    ? 'ownership_handover_completed'
                    : 'ownership_handover_confirmation',
                'claim_id' => (string) $claimId,
                'found_report_id' => (string) $foundReportId,
                'confirmed_by' => $actor,
                'status' => $completed ? 'completed' : 'pickup_scheduled'
            ]
        );

        if (($result['unregistered'] ?? false) === true) {
            // Protect a token reassigned to a different resident while
            // Firebase was processing the send request.
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

        if (($result['success'] ?? false) !== true) {
            error_log('[PawRescue Handover Push] Firebase did not accept the notice.');
        }
    } catch (Throwable $pushError) {
        // Push delivery must never roll back a committed handover.
        // Do not log tokens, proof, pickup details, or HTTP credentials.
        error_log(
            '[PawRescue Handover Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

// ============================================================
// VALIDATE REQUEST METHOD, CONTENT TYPE AND BODY SIZE
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    respondHandover(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    respondHandover(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// No photographic evidence is sent to this endpoint.
$raw = file_get_contents('php://input', false, null, 0, 4097);
if ($raw === false || strlen($raw) > 4096) {
    respondHandover(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$data = json_decode($raw, true);
if (!is_array($data) || array_is_list($data)) {
    respondHandover(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

// Reject floats, booleans, negative IDs, and leading-zero IDs.
$rawClaimId = $data['claim_id'] ?? null;
if (
    !(is_int($rawClaimId) || is_string($rawClaimId)) ||
    !preg_match('/^[1-9][0-9]*$/D', (string) $rawClaimId)
) {
    respondHandover(400, [
        'success' => false,
        'message' => 'A valid claim_id is required.'
    ]);
}

$claimId = filter_var($rawClaimId, FILTER_VALIDATE_INT, [
    'options' => ['min_range' => 1]
]);
if ($claimId === false) {
    respondHandover(400, [
        'success' => false,
        'message' => 'A valid claim_id is required.'
    ]);
}
$claimId = (int) $claimId;

// Explicit acknowledgment: the actual handover took place.
// This must be sent by the real user-action confirmation control.
if (($data['confirm_handover'] ?? null) !== true) {
    respondHandover(422, [
        'success' => false,
        'message' => 'You must confirm that the pet was actually handed over.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';
$conn = null;

try {
    // ========================================================
    // AUTHENTICATE RESIDENT
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $residentId <= 0) {
        throw new RuntimeException('Invalid authentication context.');
    }

    // Read the report ID ONLY to keep the same lock ordering
    // used by approval, pickup confirmation and rescheduling.
    // This preliminary query DOES NOT authorize the caller.
    $lookup = $conn->prepare(
        'SELECT found_report_id
         FROM pet_ownership_claims
         WHERE id = :claim_id LIMIT 1'
    );
    $lookup->execute([':claim_id' => $claimId]);
    $foundReportId = $lookup->fetchColumn();

    if ($foundReportId === false) {
        respondHandover(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $conn->beginTransaction();

    // Global lock order: pet_reports -> pet_ownership_claims.
    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':report_id' => $foundReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (!$report || $report['report_type'] !== 'found') {
        $conn->rollBack();
        respondHandover(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $claimStmt = $conn->prepare(
        'SELECT id, found_report_id, claimant_user_id, status,
                pickup_location, pickup_date, pickup_time,
                pickup_confirmed_by_claimant_at,
                finder_handover_confirmed_at,
                claimant_handover_confirmed_at,
                completed_at
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

    // Only the two participants can see or change this claim.
    // Nonparticipants receive the same 404 as a missing claim.
    if (
        !$claim || $finderId === $claimantId ||
        ($residentId !== $finderId && $residentId !== $claimantId)
    ) {
        $conn->rollBack();
        respondHandover(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $isFinder = $residentId === $finderId;
    $myTimestampColumn = $isFinder
        ? 'finder_handover_confirmed_at'
        : 'claimant_handover_confirmed_at';
    $otherTimestampColumn = $isFinder
        ? 'claimant_handover_confirmed_at'
        : 'finder_handover_confirmed_at';

    // Fully completed calls are safe to repeat (e.g. a mobile
    // request timed out after the database already committed).
    if (
        $claim['status'] === 'completed' &&
        $claim['completed_at'] !== null &&
        $claim['finder_handover_confirmed_at'] !== null &&
        $claim['claimant_handover_confirmed_at'] !== null &&
        $report['status'] === 'resolved'
    ) {
        $conn->commit();
        respondHandover(200, [
            'success' => true,
            'message' => 'The pet return has already been confirmed by both residents.',
            'claim_id' => $claimId,
            'found_report_id' => (int) $foundReportId,
            'status' => 'completed',
            'found_report_status' => 'resolved',
            'your_role' => $isFinder ? 'finder' : 'claimant',
            'already_confirmed' => true,
            'finder_handover_confirmed_at' => $claim['finder_handover_confirmed_at'],
            'claimant_handover_confirmed_at' => $claim['claimant_handover_confirmed_at'],
            'completed_at' => $claim['completed_at']
        ]);
    }

    if (!in_array((string) $report['status'],
        ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        respondHandover(409, [
            'success' => false,
            'message' => 'The Found Pet report is no longer active. Refresh the claim.'
        ]);
    }

    if ($claim['status'] !== 'pickup_scheduled') {
        $conn->rollBack();
        respondHandover(409, [
            'success' => false,
            'message' => $claim['status'] === 'reschedule_requested'
                ? 'A pickup reschedule is pending. Resolve it before confirming handover.'
                : 'This ownership claim is not ready for pet handover.',
            'status' => (string) $claim['status']
        ]);
    }

    if (
        !is_string($claim['pickup_location']) ||
        trim($claim['pickup_location']) === '' ||
        !$claim['pickup_date'] || !$claim['pickup_time'] ||
        $claim['pickup_confirmed_by_claimant_at'] === null
    ) {
        $conn->rollBack();
        respondHandover(409, [
            'success' => false,
            'message' => 'The claimant must confirm a complete pickup arrangement before handover.'
        ]);
    }

    // Prevent confirmation while a reschedule is pending, even
    // if the claim status was not updated by an older API.
    $pendingStmt = $conn->prepare(
        "SELECT id FROM pet_ownership_pickup_reschedules
         WHERE claim_id = :claim_id AND status = 'pending'
         LIMIT 1"
    );
    $pendingStmt->execute([':claim_id' => $claimId]);
    if ($pendingStmt->fetchColumn() !== false) {
        $conn->rollBack();
        respondHandover(409, [
            'success' => false,
            'message' => 'A reschedule request is pending. Confirm the new schedule first.'
        ]);
    }

    // Disputed or conflicting approved claims must not be bypassed.
    // Locking the parent report serializes competing status updates.
    $conflictStmt = $conn->prepare(
        "SELECT id FROM pet_ownership_claims
         WHERE found_report_id = :report_id AND id <> :claim_id
           AND status IN (
             'approved', 'pickup_scheduled',
             'reschedule_requested', 'disputed'
           ) LIMIT 1"
    );
    $conflictStmt->execute([
        ':report_id' => $foundReportId,
        ':claim_id' => $claimId
    ]);
    if ($conflictStmt->fetchColumn() !== false) {
        $conn->rollBack();
        respondHandover(409, [
            'success' => false,
            'message' => 'Another ownership claim or dispute must be resolved first.'
        ]);
    }

    // If this resident already confirmed, do not change their
    // original timestamp. Wait for the other resident instead.
    if ($claim[$myTimestampColumn] !== null) {
        $conn->commit();
        respondHandover(200, [
            'success' => true,
            'message' => 'Your handover confirmation was already recorded. Waiting for the other resident.',
            'claim_id' => $claimId,
            'found_report_id' => (int) $foundReportId,
            'status' => 'pickup_scheduled',
            'found_report_status' => (string) $report['status'],
            'your_role' => $isFinder ? 'finder' : 'claimant',
            'already_confirmed' => true,
            'finder_handover_confirmed_at' => $claim['finder_handover_confirmed_at'],
            'claimant_handover_confirmed_at' => $claim['claimant_handover_confirmed_at'],
            'completed_at' => null
        ]);
    }

    // The user confirms the pet WAS physically handed over. No
    // automatic timer/date check: residents may meet earlier or
    // later than planned, provided they actually exchanged the pet.
    if ($claim[$otherTimestampColumn] === null) {
        // First participant: mark their consent ONLY.
        $updateConfirmation = $conn->prepare(
            'UPDATE pet_ownership_claims
             SET ' . $myTimestampColumn . ' = NOW()
             WHERE id = :claim_id
               AND status = \'pickup_scheduled\'
               AND ' . $myTimestampColumn . ' IS NULL'
        );
        $updateConfirmation->execute([':claim_id' => $claimId]);
        if ($updateConfirmation->rowCount() !== 1) {
            throw new RuntimeException('Handover confirmation changed unexpectedly.');
        }

        $timestamps = $conn->prepare(
            'SELECT finder_handover_confirmed_at,
                    claimant_handover_confirmed_at
             FROM pet_ownership_claims WHERE id = :claim_id'
        );
        $timestamps->execute([':claim_id' => $claimId]);
        $saved = $timestamps->fetch(PDO::FETCH_ASSOC);
        if (!$saved) {
            throw new RuntimeException('Unable to retrieve handover confirmation.');
        }

        $conn->commit();

        // First confirmation: tell only the OTHER participant that
        // their confirmation is still needed. Duplicate calls return
        // earlier and never generate another notification.
        notifyOwnershipHandoverParticipant(
            $conn,
            $isFinder ? $claimantId : $finderId,
            $claimId,
            (int) $foundReportId,
            'first_confirmed',
            $isFinder
        );

        respondHandover(200, [
            'success' => true,
            'message' => 'Your handover confirmation was recorded. Waiting for the other resident to confirm.',
            'claim_id' => $claimId,
            'found_report_id' => (int) $foundReportId,
            'status' => 'pickup_scheduled',
            'found_report_status' => (string) $report['status'],
            'your_role' => $isFinder ? 'finder' : 'claimant',
            'already_confirmed' => false,
            'finder_handover_confirmed_at' => $saved['finder_handover_confirmed_at'],
            'claimant_handover_confirmed_at' => $saved['claimant_handover_confirmed_at'],
            'completed_at' => null
        ]);
    }

    // Second participant: in this SAME DB transaction, persist
    // their consent, complete claim, and resolve Found Pet report.
    $completeClaim = $conn->prepare(
        'UPDATE pet_ownership_claims
         SET ' . $myTimestampColumn . ' = NOW(),
             status = \'completed\',
             completed_at = NOW()
         WHERE id = :claim_id AND status = \'pickup_scheduled\'
           AND ' . $myTimestampColumn . ' IS NULL
           AND ' . $otherTimestampColumn . ' IS NOT NULL'
    );
    $completeClaim->execute([':claim_id' => $claimId]);
    if ($completeClaim->rowCount() !== 1) {
        throw new RuntimeException('Claim changed during final handover.');
    }

    $resolveReport = $conn->prepare(
        "UPDATE pet_reports
         SET status = 'resolved'
         WHERE id = :report_id AND report_type = 'found'
           AND status IN ('pending', 'under_review', 'in_progress')"
    );
    $resolveReport->execute([':report_id' => $foundReportId]);
    if ($resolveReport->rowCount() !== 1) {
        throw new RuntimeException('Found Pet report changed during final handover.');
    }

    // Other residents' unprocessed claims are no longer eligible
    // because this Found Pet report is now resolved. Keep their
    // history; never delete their records or private evidence.
    $closePending = $conn->prepare(
        "UPDATE pet_ownership_claims
         SET status = 'cancelled',
             cancellation_reason = 'Found Pet report resolved after confirmed handover.',
             cancelled_at = NOW()
         WHERE found_report_id = :report_id AND id <> :claim_id
           AND status = 'pending'"
    );
    $closePending->execute([
        ':report_id' => $foundReportId,
        ':claim_id' => $claimId
    ]);

    $completedStmt = $conn->prepare(
        'SELECT finder_handover_confirmed_at,
                claimant_handover_confirmed_at, completed_at
         FROM pet_ownership_claims WHERE id = :claim_id'
    );
    $completedStmt->execute([':claim_id' => $claimId]);
    $completed = $completedStmt->fetch(PDO::FETCH_ASSOC);
    if (!$completed || !$completed['completed_at']) {
        throw new RuntimeException('Unable to retrieve completed handover.');
    }

    $conn->commit();

    // Second confirmation: inform the OTHER participant that the
    // claim is completed and the report was resolved. The confirmer
    // already sees the successful response, so avoid a self-notice.
    notifyOwnershipHandoverParticipant(
        $conn,
        $isFinder ? $claimantId : $finderId,
        $claimId,
        (int) $foundReportId,
        'completed',
        $isFinder
    );

    respondHandover(200, [
        'success' => true,
        'message' => 'Both residents confirmed the pet handover. The Found Pet report is now resolved.',
        'claim_id' => $claimId,
        'found_report_id' => (int) $foundReportId,
        'status' => 'completed',
        'found_report_status' => 'resolved',
        'your_role' => $isFinder ? 'finder' : 'claimant',
        'already_confirmed' => false,
        'finder_handover_confirmed_at' => $completed['finder_handover_confirmed_at'],
        'claimant_handover_confirmed_at' => $completed['claimant_handover_confirmed_at'],
        'completed_at' => $completed['completed_at']
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    error_log('[PawRescue Ownership Handover] ' . $e->getMessage());
    respondHandover(500, [
        'success' => false,
        'message' => 'Unable to confirm the pet handover. Please try again.'
    ]);
}
