<?php
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendOwnershipClaimResponse(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

// =====================================================
// METHOD AND CONTENT TYPE
// =====================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendOwnershipClaimResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (
    stripos(
        (string) ($_SERVER['CONTENT_TYPE'] ?? ''),
        'application/json'
    ) === false
) {
    sendOwnershipClaimResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// Keep submitted evidence manageable; photos use a separate
// protected multipart upload endpoint, not this JSON request.
$rawBody = file_get_contents('php://input', false, null, 0, 32769);
if ($rawBody === false || strlen($rawBody) > 32768) {
    sendOwnershipClaimResponse(413, [
        'success' => false,
        'message' => 'The claim information is too large.'
    ]);
}

$data = json_decode($rawBody, true);
if (!is_array($data) || array_is_list($data)) {
    sendOwnershipClaimResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

// =====================================================
// VALIDATE REQUEST FIELDS
// =====================================================
$foundReportId = filter_var(
    $data['found_report_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($foundReportId === false || $foundReportId === null) {
    sendOwnershipClaimResponse(400, [
        'success' => false,
        'message' => 'Select a valid Found Pet report.'
    ]);
}

$proof = $data['proof_description'] ?? null;
if (!is_string($proof)) {
    sendOwnershipClaimResponse(400, [
        'success' => false,
        'message' => 'Describe how you can prove this pet belongs to you.'
    ]);
}

$proof = trim($proof);
if (mb_strlen($proof, 'UTF-8') < 10 || mb_strlen($proof, 'UTF-8') > 3000) {
    sendOwnershipClaimResponse(400, [
        'success' => false,
        'message' => 'Ownership evidence must be between 10 and 3000 characters.'
    ]);
}

// The claimant may optionally reference a Lost Pet report
// that THEY previously submitted.
$linkedLostReportId = $data['linked_lost_report_id'] ?? null;
if ($linkedLostReportId === '') {
    $linkedLostReportId = null;
}

if ($linkedLostReportId !== null) {
    $linkedLostReportId = filter_var(
        $linkedLostReportId,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );

    if ($linkedLostReportId === false) {
        sendOwnershipClaimResponse(400, [
            'success' => false,
            'message' => 'The linked Lost Pet report ID is invalid.'
        ]);
    }
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;

try {
    // =====================================================
    // AUTHENTICATE THE CLAIMANT (RESIDENT B)
    // =====================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $claimantId = (int) $auth['user']['id'];

    if (!($conn instanceof PDO) || $claimantId <= 0) {
        throw new RuntimeException('Invalid authenticated session context.');
    }

    $conn->beginTransaction();

    // =====================================================
    // CHECK THE FOUND PET REPORT
    // =====================================================
    // Locking the report serializes competing state changes
    // with other endpoints that also lock this same row.
    $foundStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :report_id
         LIMIT 1 FOR UPDATE'
    );
    $foundStmt->execute([':report_id' => $foundReportId]);
    $foundReport = $foundStmt->fetch(PDO::FETCH_ASSOC);

    if (!$foundReport || $foundReport['report_type'] !== 'found') {
        $conn->rollBack();
        sendOwnershipClaimResponse(404, [
            'success' => false,
            'message' => 'Found Pet report not found.'
        ]);
    }

    if ((int) $foundReport['user_id'] === $claimantId) {
        $conn->rollBack();
        sendOwnershipClaimResponse(403, [
            'success' => false,
            'message' => 'You cannot claim ownership on your own Found Pet report.'
        ]);
    }

    // Only currently active community reports accept claims.
    if (!in_array(
        (string) $foundReport['status'],
        ['pending', 'under_review', 'in_progress'],
        true
    )) {
        $conn->rollBack();
        sendOwnershipClaimResponse(409, [
            'success' => false,
            'message' => 'This Found Pet report is no longer accepting claims.'
        ]);
    }

    // =====================================================
    // VALIDATE OPTIONAL LINKED LOST PET REPORT
    // =====================================================
    if ($linkedLostReportId !== null) {
        $lostStmt = $conn->prepare(
            "SELECT id FROM pet_reports
             WHERE id = :lost_report_id
               AND user_id = :claimant_id
               AND report_type = 'lost'
             LIMIT 1"
        );
        $lostStmt->execute([
            ':lost_report_id' => $linkedLostReportId,
            ':claimant_id' => $claimantId
        ]);

        if (!$lostStmt->fetchColumn()) {
            $conn->rollBack();
            sendOwnershipClaimResponse(422, [
                'success' => false,
                'message' => 'Linked Lost Pet report must belong to your account.'
            ]);
        }
    }

    // =====================================================
    // PREVENT DUPLICATE CLAIMS
    // =====================================================
    // The database UNIQUE constraint provides an additional
    // safeguard if two devices submit at the same time.
    $existingStmt = $conn->prepare(
        'SELECT id, status
         FROM pet_ownership_claims
         WHERE found_report_id = :report_id
           AND claimant_user_id = :claimant_id
         LIMIT 1'
    );
    $existingStmt->execute([
        ':report_id' => $foundReportId,
        ':claimant_id' => $claimantId
    ]);
    $existingClaim = $existingStmt->fetch(PDO::FETCH_ASSOC);

    if ($existingClaim) {
        $conn->rollBack();
        sendOwnershipClaimResponse(409, [
            'success' => false,
            'message' => 'You already submitted a claim for this pet.',
            'claim_id' => (int) $existingClaim['id'],
            'status' => (string) $existingClaim['status']
        ]);
    }

    // =====================================================
    // STEP 25: BLOCK NEW CLAIMS AFTER SOMEONE IS APPROVED
    // =====================================================
    // Keep this check within the SAME transaction while holding
    // the parent pet_reports FOR UPDATE lock acquired above.
    // respond_claim.php (Step 24) locks that same report row
    // before approving a claimant. Consequently, a concurrent
    // approval and new submission cannot both slip through.
    //
    // This check comes AFTER duplicate detection, so a resident
    // who already submitted a claim receives their own existing
    // claim status, rather than an ambiguous reservation message.
    //
    // 'approved' covers older/legacy records; the current
    // approval endpoint uses 'pickup_scheduled'. Also block
    // active reschedules, unresolved disputes, and completed
    // claims even if an inconsistent report row remains active.
    $unavailableStmt = $conn->prepare(
        "SELECT status
         FROM pet_ownership_claims
         WHERE found_report_id = :found_report_id
           AND status IN (
               'approved', 'pickup_scheduled',
               'reschedule_requested', 'disputed', 'completed'
           )
         LIMIT 1"
    );
    $unavailableStmt->execute([
        ':found_report_id' => $foundReportId
    ]);
    $unavailableStatus = $unavailableStmt->fetchColumn();

    if ($unavailableStatus !== false) {
        $conn->rollBack();

        if ($unavailableStatus === 'disputed') {
            $closedMessage =
                'New ownership claims are temporarily unavailable ' .
                'while a previous claim is under dispute.';
        } elseif ($unavailableStatus === 'completed') {
            $closedMessage =
                'This pet has already been returned. ' .
                'New ownership claims are no longer accepted.';
        } else {
            $closedMessage =
                'Another ownership claim has already been approved ' .
                'for this Found Pet report. The pet is reserved for ' .
                'pickup, so new claims are no longer accepted.';
        }

        // Intentionally do not expose the other resident's user ID,
        // claim ID, written evidence, or private pickup location.
        sendOwnershipClaimResponse(409, [
            'success' => false,
            'error_code' => 'OWNERSHIP_CLAIMS_CLOSED',
            'message' => $closedMessage,
            'found_report_id' => (int) $foundReportId
        ]);
    }

    // =====================================================
    // CREATE PENDING CLAIM (NO AUTOMATIC APPROVAL)
    // =====================================================
    $insertStmt = $conn->prepare(
        "INSERT INTO pet_ownership_claims
         (found_report_id, claimant_user_id, linked_lost_report_id,
          proof_description, status)
         VALUES
         (:found_report_id, :claimant_user_id, :linked_lost_report_id,
          :proof_description, 'pending')"
    );
    $insertStmt->execute([
        ':found_report_id' => $foundReportId,
        ':claimant_user_id' => $claimantId,
        ':linked_lost_report_id' => $linkedLostReportId,
        ':proof_description' => $proof
    ]);

    $claimId = (int) $conn->lastInsertId();
    $conn->commit();

    // =====================================================
    // NOTIFY THE FINDER ON THEIR REGISTERED ANDROID DEVICE
    // =====================================================
    // The claim has already been committed. Sending a push is
    // best-effort: an FCM/network error must NOT undo the claim or
    // change this endpoint's successful response to an HTTP 500.
    // The sender is only called for the finder who owns this report.
    try {
        $finderId = (int) $foundReport['user_id'];

        $tokenStmt = $conn->prepare(
            "SELECT device_token
             FROM user_push_tokens
             WHERE user_id = :finder_id
               AND platform = 'android'
               AND is_active = 1
             ORDER BY last_seen_at DESC, id DESC
             LIMIT 1"
        );
        $tokenStmt->execute([':finder_id' => $finderId]);
        $finderDeviceToken = $tokenStmt->fetchColumn();

        // Browser-only recipients will still see the claim through
        // the authenticated claims API; browser push is not required.
        if (is_string($finderDeviceToken) && $finderDeviceToken !== '') {
            require_once __DIR__ . '/../push_notifications/fcm_sender.php';

            $pushResult = pawrescueSendFcmToToken(
                $finderDeviceToken,
                'New Ownership Claim',
                'Someone submitted an ownership claim for your Found Pet report. Open PawRescue to review it.',
                [
                    'type' => 'ownership_claim_received',
                    'claim_id' => $claimId,
                    'found_report_id' => $foundReportId
                ]
            );

            if (($pushResult['unregistered'] ?? false) === true) {
                // Disable only the invalid registration for this finder.
                // A token reassigned to another resident will not match.
                $disableStmt = $conn->prepare(
                    'UPDATE user_push_tokens
                     SET is_active = 0, updated_at = NOW()
                     WHERE user_id = :finder_id
                       AND device_token = :device_token
                       AND is_active = 1'
                );
                $disableStmt->execute([
                    ':finder_id' => $finderId,
                    ':device_token' => $finderDeviceToken
                ]);
            }

            if (($pushResult['success'] ?? false) !== true) {
                // Do not log any FCM token or private request information.
                error_log('[PawRescue Ownership Claim Push] Firebase did not accept the notification.');
            }
        }
    } catch (Throwable $pushError) {
        // Notification failure must never turn a saved claim into an error.
        error_log(
            '[PawRescue Ownership Claim Push] Notification unavailable (' .
            get_class($pushError) . ').'
        );
    }

    // Never return private proof or unpublished pickup details
    // in a public feed. A separate authorized claim detail
    // endpoint will provide private information later.
    sendOwnershipClaimResponse(201, [
        'success' => true,
        'message' => 'Ownership claim submitted. Waiting for the finder to review it.',
        'claim_id' => $claimId,
        'found_report_id' => (int) $foundReportId,
        'status' => 'pending'
    ]);

} catch (PDOException $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    // Preserve a useful conflict response if the UNIQUE claim
    // constraint is hit under concurrent submissions.
    if (
        $e->getCode() === '23000' &&
        (int) ($e->errorInfo[1] ?? 0) === 1062
    ) {
        sendOwnershipClaimResponse(409, [
            'success' => false,
            'message' => 'You already submitted a claim for this pet.'
        ]);
    }

    error_log('[PawRescue Submit Ownership Claim DB] ' . $e->getMessage());
    sendOwnershipClaimResponse(500, [
        'success' => false,
        'message' => 'Unable to submit ownership claim.'
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    error_log('[PawRescue Submit Ownership Claim] ' . $e->getMessage());
    sendOwnershipClaimResponse(500, [
        'success' => false,
        'message' => 'Unable to submit ownership claim.'
    ]);
}
