<?php


header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendPickupConfirmationResponse(int $statusCode, array $data): void
{
    http_response_code($statusCode);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ============================================================
// BEST-EFFORT NOTIFICATION TO THE FINDER AFTER PICKUP CONFIRMATION
// ============================================================
// Only the Found Pet report's owner is notified. The claimant does not
// select the recipient, and web-browser accounts do not require FCM.
// IMPORTANT: Only call this AFTER the database transaction commits.
function notifyFinderOfConfirmedPickup(
    PDO $conn,
    int $finderId,
    int $claimId,
    int $foundReportId
): void {
    if ($finderId <= 0 || $claimId <= 0 || $foundReportId <= 0) {
        return;
    }

    try {
        // Use one active Android registration for this finder only.
        // No notification is sent to other residents' phones.
        $tokenStmt = $conn->prepare(
            "SELECT id, device_token
             FROM user_push_tokens
             WHERE user_id = :finder_id
               AND platform = 'android'
               AND is_active = 1
             ORDER BY last_seen_at DESC, id DESC
             LIMIT 1"
        );
        $tokenStmt->execute([':finder_id' => $finderId]);
        $device = $tokenStmt->fetch(PDO::FETCH_ASSOC);

        if (!is_array($device) ||
            !is_string($device['device_token'] ?? null) ||
            $device['device_token'] === '') {
            return;
        }

        require_once __DIR__ . '/../push_notifications/fcm_sender.php';

        $result = pawrescueSendFcmToToken(
            $device['device_token'],
            'Pickup Arrangement Confirmed',
            'The claimant confirmed your proposed pickup arrangement. Open PawRescue to view the claim.',
            [
                'type' => 'ownership_pickup_confirmed',
                'claim_id' => (string) $claimId,
                'found_report_id' => (string) $foundReportId,
                'status' => 'pickup_scheduled'
            ]
        );

        if (($result['unregistered'] ?? false) === true) {
            // Mark only this invalid token inactive. Protect against a
            // concurrent reassignment of the token to another resident.
            $disable = $conn->prepare(
                'UPDATE user_push_tokens
                 SET is_active = 0, updated_at = NOW()
                 WHERE id = :token_id
                   AND user_id = :finder_id
                   AND device_token = :device_token
                   AND platform = :platform
                   AND is_active = 1'
            );
            $disable->execute([
                ':token_id' => (int) $device['id'],
                ':finder_id' => $finderId,
                ':device_token' => $device['device_token'],
                ':platform' => 'android'
            ]);
        }

        if (($result['success'] ?? false) !== true) {
            // Never expose token values or confidential claim details.
            error_log('[PawRescue Pickup Confirmation Push] Firebase did not accept the notice.');
        }
    } catch (Throwable $pushError) {
        // The pickup has already been confirmed, so an FCM failure must
        // not turn this successful API operation into an HTTP 500.
        error_log(
            '[PawRescue Pickup Confirmation Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

// ============================================================
// VALIDATE REQUEST
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendPickupConfirmationResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    sendPickupConfirmationResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// This endpoint accepts only a small JSON object (no photos).
$raw = file_get_contents('php://input', false, null, 0, 4097);
if ($raw === false || strlen($raw) > 4096) {
    sendPickupConfirmationResponse(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$payload = json_decode($raw, true);
if (!is_array($payload) || array_is_list($payload)) {
    sendPickupConfirmationResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$claimId = filter_var(
    $payload['claim_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($claimId === false || $claimId === null) {
    sendPickupConfirmationResponse(400, [
        'success' => false,
        'message' => 'A valid claim ID is required.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
try {
    // ========================================================
    // VERIFY RESIDENT B - CLAIMANT
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $claimantId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $claimantId <= 0) {
        throw new RuntimeException('Invalid authentication context.');
    }

    // Read the report ID only to establish the transaction lock
    // order. This lookup does NOT authorize the caller.
    // Every mutation locks: Found Pet report -> ownership claim.
    $reportLookup = $conn->prepare(
        'SELECT found_report_id
         FROM pet_ownership_claims
         WHERE id = :claim_id
         LIMIT 1'
    );
    $reportLookup->execute([':claim_id' => $claimId]);
    $foundReportId = $reportLookup->fetchColumn();

    if ($foundReportId === false) {
        sendPickupConfirmationResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $conn->beginTransaction();

    // Lock the parent report before accessing the claim to avoid
    // races with approval, report resolution, and rescheduling.
    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :found_report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':found_report_id' => $foundReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    // Never confirm an inactive, deleted, or non-Found report.
    if (!$report || $report['report_type'] !== 'found') {
        $conn->rollBack();
        sendPickupConfirmationResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $claimStmt = $conn->prepare(
        'SELECT id, found_report_id, claimant_user_id, status,
                pickup_location, pickup_latitude, pickup_longitude,
                pickup_date, pickup_time, pickup_timezone,
                pickup_confirmed_by_claimant_at
         FROM pet_ownership_claims
         WHERE id = :claim_id AND found_report_id = :found_report_id
         LIMIT 1 FOR UPDATE'
    );
    $claimStmt->execute([
        ':claim_id' => $claimId,
        ':found_report_id' => $foundReportId
    ]);
    $claim = $claimStmt->fetch(PDO::FETCH_ASSOC);

    // Return 404 to avoid disclosing someone else's private claim.
    if (!$claim || (int) $claim['claimant_user_id'] !== $claimantId ||
        (int) $report['user_id'] === $claimantId) {
        $conn->rollBack();
        sendPickupConfirmationResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    if (!in_array((string) $report['status'],
        ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        sendPickupConfirmationResponse(409, [
            'success' => false,
            'message' => 'This Found Pet report is no longer active.'
        ]);
    }

    if ($claim['status'] !== 'pickup_scheduled') {
        $conn->rollBack();
        sendPickupConfirmationResponse(409, [
            'success' => false,
            'message' => $claim['status'] === 'reschedule_requested'
                ? 'A reschedule request is pending. Confirm the arrangement after rescheduling is settled.'
                : 'This claim does not currently have an approved pickup arrangement.',
            'status' => (string) $claim['status']
        ]);
    }

    if (!$claim['pickup_location'] || !$claim['pickup_date'] || !$claim['pickup_time']) {
        $conn->rollBack();
        sendPickupConfirmationResponse(409, [
            'success' => false,
            'message' => 'The pickup arrangement is incomplete. Ask the finder to set it again.'
        ]);
    }

    // Do not accept the old arrangement while a reschedule is
    // pending. Even if an older API forgot to update claim status,
    // this check protects against conflicting confirmations.
    $rescheduleStmt = $conn->prepare(
        "SELECT id FROM pet_ownership_pickup_reschedules
         WHERE claim_id = :claim_id AND status = 'pending'
         LIMIT 1"
    );
    $rescheduleStmt->execute([':claim_id' => $claimId]);
    if ($rescheduleStmt->fetchColumn() !== false) {
        $conn->rollBack();
        sendPickupConfirmationResponse(409, [
            'success' => false,
            'message' => 'A pickup reschedule is pending. Resolve it before confirming.'
        ]);
    }

    // Idempotent: repeated taps do not change the timestamp.
    if ($claim['pickup_confirmed_by_claimant_at'] !== null) {
        $conn->commit();
        sendPickupConfirmationResponse(200, [
            'success' => true,
            'message' => 'You have already confirmed this pickup arrangement.',
            'claim_id' => (int) $claim['id'],
            'found_report_id' => (int) $foundReportId,
            'status' => 'pickup_scheduled',
            'already_confirmed' => true,
            'pickup' => [
                'location' => (string) $claim['pickup_location'],
                'latitude' => $claim['pickup_latitude'] === null
                    ? null : (float) $claim['pickup_latitude'],
                'longitude' => $claim['pickup_longitude'] === null
                    ? null : (float) $claim['pickup_longitude'],
                'date' => (string) $claim['pickup_date'],
                'time' => (string) $claim['pickup_time'],
                'timezone' => (string) $claim['pickup_timezone'],
                'claimant_confirmed_at' => (string) $claim['pickup_confirmed_by_claimant_at']
            ]
        ]);
    }

    // The saved date/time is Asia/Manila local time. An expired
    // appointment must be rescheduled instead of newly accepted.
    $manila = new DateTimeZone('Asia/Manila');
    $pickupAt = DateTimeImmutable::createFromFormat(
        '!Y-m-d H:i:s',
        (string) $claim['pickup_date'] . ' ' . (string) $claim['pickup_time'],
        $manila
    );

    if (!$pickupAt || $pickupAt <= new DateTimeImmutable('now', $manila)) {
        $conn->rollBack();
        sendPickupConfirmationResponse(409, [
            'success' => false,
            'message' => 'The proposed pickup time has passed. Please request a new schedule.'
        ]);
    }

    // The status remains pickup_scheduled. Confirmation of a
    // scheduled meeting is NOT confirmation of actual handover.
    $update = $conn->prepare(
        "UPDATE pet_ownership_claims
         SET pickup_confirmed_by_claimant_at = NOW()
         WHERE id = :claim_id
           AND claimant_user_id = :claimant_id
           AND status = 'pickup_scheduled'
           AND pickup_confirmed_by_claimant_at IS NULL"
    );
    $update->execute([
        ':claim_id' => $claimId,
        ':claimant_id' => $claimantId
    ]);

    if ($update->rowCount() !== 1) {
        throw new RuntimeException('Pickup confirmation changed during update.');
    }

    // Get the database timestamp for an accurate response.
    $confirmedStmt = $conn->prepare(
        'SELECT pickup_confirmed_by_claimant_at
         FROM pet_ownership_claims
         WHERE id = :claim_id'
    );
    $confirmedStmt->execute([':claim_id' => $claimId]);
    $confirmedAt = $confirmedStmt->fetchColumn();

    $conn->commit();

    // Notify only after the claimant confirms for the FIRST time.
    // A repeated confirmation above returns early and sends no duplicate.
    notifyFinderOfConfirmedPickup(
        $conn,
        (int) $report['user_id'],
        (int) $claimId,
        (int) $foundReportId
    );

    sendPickupConfirmationResponse(200, [
        'success' => true,
        'message' => 'Pickup arrangement confirmed. Meet the finder at the agreed location and time.',
        'claim_id' => $claimId,
        'found_report_id' => (int) $foundReportId,
        'status' => 'pickup_scheduled',
        'already_confirmed' => false,
        'pickup' => [
            'location' => (string) $claim['pickup_location'],
            'latitude' => $claim['pickup_latitude'] === null
                ? null : (float) $claim['pickup_latitude'],
            'longitude' => $claim['pickup_longitude'] === null
                ? null : (float) $claim['pickup_longitude'],
            'date' => (string) $claim['pickup_date'],
            'time' => (string) $claim['pickup_time'],
            'timezone' => (string) $claim['pickup_timezone'],
            'claimant_confirmed_at' => $confirmedAt === false ? null : (string) $confirmedAt
        ]
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Confirm Ownership Pickup] ' . $e->getMessage());
    sendPickupConfirmationResponse(500, [
        'success' => false,
        'message' => 'Unable to confirm the pickup arrangement. Please try again.'
    ]);
}
