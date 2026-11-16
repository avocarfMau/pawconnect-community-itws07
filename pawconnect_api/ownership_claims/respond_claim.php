<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function respondToClaim(int $httpStatus, array $body): void
{
    http_response_code($httpStatus);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ============================================================
// BEST-EFFORT FCM NOTICE TO THE SPECIFIC RESIDENT
// ============================================================
// This is an internal helper, never a public notification endpoint.
// The caller supplies user IDs obtained from authorized claim records,
// not IDs supplied by the client. A browser-only account has no Android
// FCM token; it can still check claim status through get_claims.php.
// IMPORTANT: Call only AFTER the claim transaction commits.
function notifyOwnershipClaimResident(
    PDO $conn,
    int $recipientId,
    string $title,
    string $message,
    string $type,
    int $claimId,
    int $foundReportId,
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
                'claim_id' => (string) $claimId,
                'found_report_id' => (string) $foundReportId,
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
            // Do not log the FCM token, credentials, or private claim data.
            error_log('[PawRescue Claim Decision Push] Firebase did not accept a notice.');
        }
    } catch (Throwable $pushError) {
        // A notification error must not invalidate an approved/rejected claim.
        error_log(
            '[PawRescue Claim Decision Push] Notice unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    respondToClaim(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    respondToClaim(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// Limit request size. Ownership photos use the separate upload endpoint.
$raw = file_get_contents('php://input', false, null, 0, 16385);
if ($raw === false || strlen($raw) > 16384) {
    respondToClaim(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$data = json_decode($raw, true);
if (!is_array($data) || array_is_list($data)) {
    respondToClaim(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$claimId = filter_var(
    $data['claim_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);
$action = $data['action'] ?? null;

if (
    $claimId === false || $claimId === null ||
    !is_string($action) || !in_array($action, ['approve', 'reject'], true)
) {
    respondToClaim(400, [
        'success' => false,
        'message' => 'Invalid claim ID or action.'
    ]);
}

$pickupLocation = null;
$pickupLatitude = null;
$pickupLongitude = null;
$pickupDate = null;
$pickupTime = null;
$rejectionReason = null;

// ============================================================
// VALIDATE APPROVAL ARRANGEMENT (ASIA/MANILA LOCAL TIME)
// ============================================================
if ($action === 'approve') {
    $locationInput = $data['pickup_location'] ?? null;
    if (!is_string($locationInput)) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Please provide the proposed pickup location.'
        ]);
    }

    $pickupLocation = trim($locationInput);
    if (
        strlen($pickupLocation) < 5 || strlen($pickupLocation) > 255 ||
        preg_match('/[\x00-\x1F\x7F]/', $pickupLocation)
    ) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Pickup location must be a single line (5 to 255 bytes).'
        ]);
    }

    // Never accept a single coordinate without its partner.
    $latRaw = $data['pickup_latitude'] ?? null;
    $lngRaw = $data['pickup_longitude'] ?? null;
    if (($latRaw === null) !== ($lngRaw === null)) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Both pickup coordinates are required when using a map pin.'
        ]);
    }

    if ($latRaw !== null) {
        if (
            (!is_float($latRaw) && !is_int($latRaw) && !is_string($latRaw)) ||
            (!is_float($lngRaw) && !is_int($lngRaw) && !is_string($lngRaw)) ||
            !is_numeric($latRaw) || !is_numeric($lngRaw) ||
            !is_finite((float) $latRaw) || !is_finite((float) $lngRaw)
        ) {
            respondToClaim(422, [
                'success' => false,
                'message' => 'Invalid pickup coordinates.'
            ]);
        }

        $pickupLatitude = (float) $latRaw;
        $pickupLongitude = (float) $lngRaw;
        if (
            $pickupLatitude < -90 || $pickupLatitude > 90 ||
            $pickupLongitude < -180 || $pickupLongitude > 180
        ) {
            respondToClaim(422, [
                'success' => false,
                'message' => 'Pickup coordinates are outside the valid range.'
            ]);
        }
    }

    $dateInput = $data['pickup_date'] ?? null;
    $timeInput = $data['pickup_time'] ?? null;
    if (!is_string($dateInput) ||
        !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $dateInput)) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Select a valid pickup date (YYYY-MM-DD).'
        ]);
    }

    [$year, $month, $day] = array_map('intval', explode('-', $dateInput));
    if (!checkdate($month, $day, $year)) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Pickup date does not exist.'
        ]);
    }

    if (!is_string($timeInput) ||
        !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/D', $timeInput)) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Select a valid pickup time (HH:MM).'
        ]);
    }

    $pickupDate = $dateInput;
    $pickupTime = strlen($timeInput) === 5 ? $timeInput . ':00' : $timeInput;
    $timezone = new DateTimeZone('Asia/Manila');
    $scheduledAt = DateTimeImmutable::createFromFormat(
        '!Y-m-d H:i:s',
        $pickupDate . ' ' . $pickupTime,
        $timezone
    );
    if (!$scheduledAt || $scheduledAt <= new DateTimeImmutable('now', $timezone)) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Pickup date and time must be in the future (Philippine time).'
        ]);
    }
}

// ============================================================
// OPTIONAL REJECTION REASON
// ============================================================
if ($action === 'reject' && array_key_exists('rejection_reason', $data)) {
    if ($data['rejection_reason'] !== null && !is_string($data['rejection_reason'])) {
        respondToClaim(422, [
            'success' => false,
            'message' => 'Invalid rejection reason.'
        ]);
    }
    if (is_string($data['rejection_reason'])) {
        $rejectionReason = trim($data['rejection_reason']);
        if (mb_strlen($rejectionReason, 'UTF-8') > 1000) {
            respondToClaim(422, [
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
    // AUTHENTICATE RESIDENT A - FINDER
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $finderId = (int) ($auth['user']['id'] ?? 0);
    if (!($conn instanceof PDO) || $finderId <= 0) {
        throw new RuntimeException('Invalid authentication context.');
    }

    // Read the association before acquiring locks. This is NOT
    // authorization; it only identifies which report to lock FIRST.
    // Every claim mutation locks report -> claim in this order.
    $lookup = $conn->prepare(
        'SELECT found_report_id FROM pet_ownership_claims
         WHERE id = :claim_id LIMIT 1'
    );
    $lookup->execute([':claim_id' => $claimId]);
    $foundReportId = $lookup->fetchColumn();
    if ($foundReportId === false) {
        respondToClaim(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    $conn->beginTransaction();

    // Serialize competing approvals against the same FOUND report.
    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports WHERE id = :found_report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':found_report_id' => $foundReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (
        !$report ||
        $report['report_type'] !== 'found' ||
        (int) $report['user_id'] !== $finderId
    ) {
        $conn->rollBack();
        respondToClaim(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    if (!in_array((string) $report['status'],
        ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        respondToClaim(409, [
            'success' => false,
            'message' => 'This Found Pet report is no longer active.'
        ]);
    }

    $claimStmt = $conn->prepare(
        'SELECT id, found_report_id, claimant_user_id, status, proof_description
         FROM pet_ownership_claims
         WHERE id = :claim_id AND found_report_id = :found_report_id
         LIMIT 1 FOR UPDATE'
    );
    $claimStmt->execute([
        ':claim_id' => $claimId,
        ':found_report_id' => $foundReportId
    ]);
    $claim = $claimStmt->fetch(PDO::FETCH_ASSOC);
    if (!$claim) {
        $conn->rollBack();
        respondToClaim(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    if ($claim['status'] !== 'pending') {
        $conn->rollBack();
        respondToClaim(409, [
            'success' => false,
            'message' => 'Only pending ownership claims can be approved or rejected.',
            'status' => (string) $claim['status']
        ]);
    }

    // A claim must have written proof; private photos are optional.
    // The finder reviews the evidence manually before approval.
    if ($action === 'approve' && trim((string) $claim['proof_description']) === '') {
        $conn->rollBack();
        respondToClaim(422, [
            'success' => false,
            'message' => 'Ownership evidence is missing.'
        ]);
    }

    if ($action === 'approve') {
        // Includes unresolved disputes, which must not be bypassed
        // by approving a different claimant.
        $activeStmt = $conn->prepare(
            "SELECT id FROM pet_ownership_claims
             WHERE found_report_id = :found_report_id
               AND id <> :claim_id
               AND status IN (
                   'approved', 'pickup_scheduled',
                   'reschedule_requested', 'disputed'
               )
             LIMIT 1"
        );
        $activeStmt->execute([
            ':found_report_id' => $foundReportId,
            ':claim_id' => $claimId
        ]);
        if ($activeStmt->fetchColumn() !== false) {
            $conn->rollBack();
            respondToClaim(409, [
                'success' => false,
                'message' => 'Another ownership claim already has an active pickup or unresolved dispute for this pet.'
            ]);
        }

        // Approval and private pickup offer are saved atomically.
        // Claimant confirmation of the offer is a SEPARATE step.
        $update = $conn->prepare(
            "UPDATE pet_ownership_claims
             SET status = 'pickup_scheduled',
                 approved_at = NOW(),
                 pickup_location = :pickup_location,
                 pickup_latitude = :pickup_latitude,
                 pickup_longitude = :pickup_longitude,
                 pickup_date = :pickup_date,
                 pickup_time = :pickup_time,
                 pickup_timezone = 'Asia/Manila',
                 pickup_confirmed_by_claimant_at = NULL,
                 rejection_reason = NULL
             WHERE id = :claim_id AND status = 'pending'"
        );
        $update->execute([
            ':pickup_location' => $pickupLocation,
            ':pickup_latitude' => $pickupLatitude,
            ':pickup_longitude' => $pickupLongitude,
            ':pickup_date' => $pickupDate,
            ':pickup_time' => $pickupTime,
            ':claim_id' => $claimId
        ]);
        if ($update->rowCount() !== 1) {
            throw new RuntimeException('Claim changed during approval.');
        }

        // ====================================================
        // CLOSE ALL OTHER PENDING CLAIMS IN THE SAME TRANSACTION
        // ====================================================
        // Do not leave the other applicants with a misleading
        // Pending status. Their evidence was not rejected on its
        // merits; another claimant was selected first. Cancelled
        // claims remain visible in the private Sent Claims history,
        // including the explanation below.
        //
        // This is performed while the parent pet_reports row is
        // locked, using the same report -> claim lock order as
        // other mutation endpoints. If any update fails, both the
        // winner's approval and these cancellations roll back.
        // Keep a private list of affected applicants for post-commit
        // notifications. No private evidence or pickup data is sent.
        $otherPendingStmt = $conn->prepare(
            "SELECT id, claimant_user_id
             FROM pet_ownership_claims
             WHERE found_report_id = :found_report_id
               AND id <> :approved_claim_id
               AND status = 'pending'"
        );
        $otherPendingStmt->execute([
            ':found_report_id' => $foundReportId,
            ':approved_claim_id' => $claimId
        ]);
        $otherPendingRecipients = $otherPendingStmt->fetchAll(PDO::FETCH_ASSOC);

        $closePending = $conn->prepare(
            "UPDATE pet_ownership_claims
             SET status = 'cancelled',
                 cancellation_reason = :cancellation_reason,
                 cancelled_at = NOW()
             WHERE found_report_id = :found_report_id
               AND id <> :approved_claim_id
               AND status = 'pending'"
        );
        $closePending->execute([
            ':cancellation_reason' =>
                'Another ownership claim was approved for this Found Pet report. ' .
                'The pet is reserved for an arranged pickup. Your claim is no longer pending.',
            ':found_report_id' => $foundReportId,
            ':approved_claim_id' => $claimId
        ]);
        $otherClaimsClosed = $closePending->rowCount();

        $conn->commit();

        // The approved claimant receives a notification only if their
        // account currently has an active Android device registered.
        notifyOwnershipClaimResident(
            $conn,
            (int) $claim['claimant_user_id'],
            'Ownership Claim Approved',
            'Your ownership claim was approved. Open PawRescue to review the pickup arrangement.',
            'ownership_claim_approved',
            $claimId,
            (int) $foundReportId,
            'pickup_scheduled'
        );

        // Other applicants have been cancelled (not rejected). Tell
        // each affected resident their claim is no longer pending.
        // No notice is sent to unrelated residents or browser-only
        // accounts with no active Android token.
        foreach ($otherPendingRecipients as $otherClaim) {
            $otherClaimId = (int) ($otherClaim['id'] ?? 0);
            $otherUserId = (int) ($otherClaim['claimant_user_id'] ?? 0);
            if ($otherClaimId <= 0 || $otherUserId <= 0) {
                continue;
            }
            notifyOwnershipClaimResident(
                $conn,
                $otherUserId,
                'Ownership Claim Closed',
                'Another ownership claim was approved for this Found Pet report. Your claim is no longer pending.',
                'ownership_claim_cancelled',
                $otherClaimId,
                (int) $foundReportId,
                'cancelled'
            );
        }

        respondToClaim(200, [
            'success' => true,
            'message' => 'Ownership claim approved. Waiting for the claimant to confirm the pickup arrangement.',
            'claim_id' => $claimId,
            'found_report_id' => (int) $foundReportId,
            'action' => 'approve',
            'status' => 'pickup_scheduled',
            'other_pending_claims_closed' => $otherClaimsClosed,
            'pickup' => [
                'location' => $pickupLocation,
                'latitude' => $pickupLatitude,
                'longitude' => $pickupLongitude,
                'date' => $pickupDate,
                'time' => $pickupTime,
                'timezone' => 'Asia/Manila',
                'claimant_confirmed_at' => null
            ]
        ]);
    }

    // Rejection changes only this claim. The Found Pet report
    // stays open for other residents to submit valid evidence.
    $update = $conn->prepare(
        "UPDATE pet_ownership_claims
         SET status = 'rejected',
             rejected_at = NOW(),
             rejection_reason = :rejection_reason
         WHERE id = :claim_id AND status = 'pending'"
    );
    $update->execute([
        ':rejection_reason' => $rejectionReason,
        ':claim_id' => $claimId
    ]);
    if ($update->rowCount() !== 1) {
        throw new RuntimeException('Claim changed during rejection.');
    }

    $conn->commit();

    // Only the owner of the rejected claim receives this notice.
    // Do not include the private rejection reason in the system tray.
    notifyOwnershipClaimResident(
        $conn,
        (int) $claim['claimant_user_id'],
        'Ownership Claim Update',
        'Your ownership claim was not approved. Open PawRescue to view the result.',
        'ownership_claim_rejected',
        $claimId,
        (int) $foundReportId,
        'rejected'
    );

    respondToClaim(200, [
        'success' => true,
        'message' => 'Ownership claim rejected. The Found Pet report remains active.',
        'claim_id' => $claimId,
        'found_report_id' => (int) $foundReportId,
        'action' => 'reject',
        'status' => 'rejected',
        'rejection_reason' => $rejectionReason
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Respond Ownership Claim] ' . $e->getMessage());
    respondToClaim(500, [
        'success' => false,
        'message' => 'Unable to process the ownership claim. Please try again.'
    ]);
}
