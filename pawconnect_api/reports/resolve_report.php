<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// ============================================================
// JSON RESPONSE HELPERS
// ============================================================
function sendResolveResponse(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// Always release locks before responding with an error.
function refuseResolve(int $status, string $message, ?PDO $conn = null): void
{
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    sendResolveResponse($status, [
        'success' => false,
        'message' => $message
    ]);
}

// ============================================================
// ALLOW POST REQUESTS ONLY
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    refuseResolve(405, 'Method not allowed.');
}

// ============================================================
// REQUIRE JSON
// ============================================================
if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    refuseResolve(415, 'Content-Type must be application/json.');
}

// ============================================================
// READ AND VALIDATE REQUEST
// ============================================================
$rawInput = file_get_contents('php://input');
$data = json_decode($rawInput === false ? '' : $rawInput, true);

if (!is_array($data) || array_is_list($data)) {
    refuseResolve(400, 'Invalid JSON request.');
}

$reportId = filter_var(
    $data['report_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($reportId === false || $reportId === null) {
    refuseResolve(400, 'Invalid report ID.');
}

// ============================================================
// AUTHENTICATE RESIDENT
// ============================================================
require_once __DIR__ . '/../middleware/auth_middleware.php';
$conn = null;

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $residentId <= 0) {
        throw new RuntimeException('Invalid authenticated session context.');
    }

    // ========================================================
    // LOCK THE REPORT FIRST (SAME ORDER AS OWNERSHIP ENDPOINTS)
    // ========================================================
    // The ownership claim APIs also lock the parent pet_reports
    // row first. This prevents a concurrent claim submission,
    // approval or handover from racing against manual resolution.
    $conn->beginTransaction();

    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :report_id AND user_id = :resident_id
           AND report_type IN (\'lost\', \'found\')
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([
        ':report_id' => $reportId,
        ':resident_id' => $residentId
    ]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (!$report) {
        refuseResolve(404, 'Report not found or access denied.', $conn);
    }

    // ========================================================
    // PRESERVE EXISTING REPORT STATUS RULES
    // ========================================================
    if ($report['status'] === 'resolved') {
        refuseResolve(409, 'This report is already resolved.', $conn);
    }

    if ($report['status'] === 'closed') {
        refuseResolve(409, 'Closed reports cannot be modified.', $conn);
    }

    if (!in_array(
        (string) $report['status'],
        ['pending', 'under_review', 'in_progress'],
        true
    )) {
        refuseResolve(409, 'This report cannot be resolved.', $conn);
    }

    // ========================================================
    // FOUND PET CLAIM PROTECTION
    // ========================================================
    // FOUND reports with pending/approved/pickup/disputed claims
    // cannot be manually marked resolved: handover must be
    // completed through ownership_claims/confirm_handover.php.
    //
    // Even PENDING claims are protected so a finder does not
    // silently close a report while someone awaits a decision.
    // Rejected/cancelled claim history does not block resolution.
    // An unexpectedly COMPLETED claim on an active report is
    // treated as inconsistent state and must not be bypassed.
    //
    // The locked pet_reports row serializes this lookup with
    // claim mutations that use the same parent-first lock order.
    if ($report['report_type'] === 'found') {
        $claimStmt = $conn->prepare(
            "SELECT status
             FROM pet_ownership_claims
             WHERE found_report_id = :report_id
               AND status IN (
                   'pending', 'approved', 'pickup_scheduled',
                   'reschedule_requested', 'disputed', 'completed'
               )
             LIMIT 1"
        );
        $claimStmt->execute([':report_id' => $reportId]);
        $claimStatus = $claimStmt->fetchColumn();

        if ($claimStatus !== false) {
            if ($claimStatus === 'completed') {
                refuseResolve(
                    409,
                    'A completed ownership claim already exists. Please refresh the report or contact support if its status is incorrect.',
                    $conn
                );
            }

            if ($claimStatus === 'pending') {
                refuseResolve(
                    409,
                    'This Found Pet report has a pending ownership claim. Review the claim before resolving the report.',
                    $conn
                );
            }

            if ($claimStatus === 'disputed') {
                refuseResolve(
                    409,
                    'This Found Pet report has a disputed ownership claim. Resolve the dispute before closing the report.',
                    $conn
                );
            }

            refuseResolve(
                409,
                'This Found Pet report has an active ownership claim or pickup arrangement. Complete the confirmed pet handover before the report can be resolved.',
                $conn
            );
        }
    }

    // ========================================================
    // LOST PET RECOVERY PROTECTION (STEP 60)
    // ========================================================
    // An active "I Found This Pet" submission must be reviewed
    // before the Lost Pet owner can resolve the report manually.
    // Otherwise the owner could bypass the required independent
    // owner + finder handover confirmations.
    //
    // Pending: owner must review the finder's submission first.
    // Approved/pickup_scheduled/reschedule_requested: the return
    // must finish through the secure two-party handover endpoint.
    // Disputed: manual resolution is blocked until resolved.
    // Completed + active Lost Pet report is an inconsistent state
    // that must never be bypassed by manually resolving it.
    // Rejected/cancelled history does NOT block manual resolution.
    //
    // Both this endpoint and the recovery write endpoints lock
    // the pet_reports parent row first, preventing race conditions
    // between manual resolution and recovery state changes.
    if ($report['report_type'] === 'lost') {
        $recoveryStmt = $conn->prepare(
            "SELECT status
             FROM pet_lost_recovery_reports
             WHERE lost_report_id = :report_id
               AND status IN (
                   'pending', 'approved', 'pickup_scheduled',
                   'reschedule_requested', 'disputed', 'completed'
               )
             LIMIT 1"
        );
        $recoveryStmt->execute([':report_id' => $reportId]);
        $recoveryStatus = $recoveryStmt->fetchColumn();

        if ($recoveryStatus !== false) {
            if ($recoveryStatus === 'completed') {
                refuseResolve(
                    409,
                    'A completed Lost Pet recovery already exists. Please refresh the report or contact support if its status is incorrect.',
                    $conn
                );
            }

            if ($recoveryStatus === 'pending') {
                refuseResolve(
                    409,
                    'This Lost Pet report has a pending recovery submission. Review the submission before resolving the report.',
                    $conn
                );
            }

            if ($recoveryStatus === 'disputed') {
                refuseResolve(
                    409,
                    'This Lost Pet report has a disputed recovery. Resolve the dispute before closing the report.',
                    $conn
                );
            }

            refuseResolve(
                409,
                'This Lost Pet report has an active recovery or pickup arrangement. Complete the confirmed pet handover before the report can be resolved.',
                $conn
            );
        }
    }

    // ========================================================
    // UPDATE REPORT STATUS
    // ========================================================
    $update = $conn->prepare(
        "UPDATE pet_reports
         SET status = 'resolved', updated_at = NOW()
         WHERE id = :report_id
           AND user_id = :resident_id
           AND status IN ('pending', 'under_review', 'in_progress')"
    );
    $update->execute([
        ':report_id' => $reportId,
        ':resident_id' => $residentId
    ]);

    if ($update->rowCount() !== 1) {
        refuseResolve(
            409,
            'Report status changed. Please refresh and try again.',
            $conn
        );
    }

    $conn->commit();

    // Preserve original response fields used by My Reports.
    sendResolveResponse(200, [
        'success' => true,
        'message' => 'Pet report marked as resolved successfully.',
        'report_id' => (int) $reportId,
        'status' => 'resolved'
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    error_log('[PawRescue Resolve Report Error] ' . $e->getMessage());

    sendResolveResponse(500, [
        'success' => false,
        'message' => 'Unable to resolve pet report.'
    ]);
}
