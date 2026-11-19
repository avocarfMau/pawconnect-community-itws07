<?php
// PawConnect - Soft-delete a resident's Lost/Found report.
// Requires pet_reports.deleted_at DATETIME NULL and deletion-aware read/write APIs.
// CORS/OPTIONS are handled centrally by cors.php through .htaccess.
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function deleteResponse(int $code, bool $success, string $message): void {
    http_response_code($code);
    echo json_encode(['success' => $success, 'message' => $message]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    deleteResponse(405, false, 'Method not allowed.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === false) {
    deleteResponse(415, false, 'Content-Type must be application/json.');
}

$conn = null;
try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $userId = (int) $auth['user']['id'];

    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body) || array_is_list($body)) {
        deleteResponse(400, false, 'Invalid JSON request.');
    }
    $reportId = filter_var($body['report_id'] ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1]
    ]);
    if ($reportId === false || $reportId === null) {
        deleteResponse(400, false, 'Invalid report ID.');
    }

    $conn->beginTransaction();
    $stmt = $conn->prepare(
        "SELECT id, report_type, status, deleted_at FROM pet_reports
         WHERE id = :report_id AND user_id = :user_id
           AND report_type IN ('lost', 'found') LIMIT 1 FOR UPDATE"
    );
    $stmt->execute([':report_id' => $reportId, ':user_id' => $userId]);
    $report = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$report) {
        $conn->rollBack();
        deleteResponse(404, false, 'Report not found or access denied.');
    }
    if ($report['deleted_at'] !== null) {
        $conn->rollBack();
        deleteResponse(409, false, 'This report has already been archived. Please refresh.');
    }
    if (!in_array($report['status'], ['pending', 'under_review', 'in_progress'], true)) {
        $conn->rollBack();
        deleteResponse(409, false, 'Resolved or closed reports cannot be archived.');
    }

    // Block archive while any ownership claim still needs action.
    // Terminal claims remain in history and do not block archiving.
    $claimCheck = $conn->prepare(
        "SELECT id FROM pet_ownership_claims
         WHERE (found_report_id = :found_id OR linked_lost_report_id = :lost_id)
           AND status NOT IN ('rejected', 'cancelled', 'completed')
         LIMIT 1"
    );
    $claimCheck->execute([':found_id' => $reportId, ':lost_id' => $reportId]);
    if ($claimCheck->fetchColumn() !== false) {
        $conn->rollBack();
        deleteResponse(409, false, 'This report has an ongoing ownership claim. Complete or cancel the claim before archiving.');
    }

    // Recovery and assistance workflows have separate status lifecycles.
    // Until their terminal states are verified, preserve safety by blocking
    // archive whenever one of these linked records exists.
    $recoveryCheck = $conn->prepare(
        'SELECT id FROM pet_lost_recovery_reports
         WHERE lost_report_id = :lost_id OR linked_found_report_id = :found_id
         LIMIT 1'
    );
    $recoveryCheck->execute([':lost_id' => $reportId, ':found_id' => $reportId]);
    if ($recoveryCheck->fetchColumn() !== false) {
        $conn->rollBack();
        deleteResponse(409, false, 'This report has a linked recovery record. Archiving is temporarily unavailable until its workflow is reviewed.');
    }

    $assistanceCheck = $conn->prepare(
        'SELECT id FROM animal_assistance_cases
         WHERE found_report_id = :report_id LIMIT 1'
    );
    $assistanceCheck->execute([':report_id' => $reportId]);
    if ($assistanceCheck->fetchColumn() !== false) {
        $conn->rollBack();
        deleteResponse(409, false, 'This report has a linked animal assistance case. Archiving is temporarily unavailable until its workflow is reviewed.');
    }

    // Preserve the report and every linked claim, recovery and assistance case.
    // Deletion-aware listing and workflow endpoints must exclude deleted reports.
    $delete = $conn->prepare(
        "UPDATE pet_reports
         SET deleted_at = NOW()
         WHERE id = :id AND user_id = :user_id
           AND deleted_at IS NULL
           AND report_type IN ('lost', 'found')
           AND status IN ('pending', 'under_review', 'in_progress')"
    );
    $delete->execute([':id' => $reportId, ':user_id' => $userId]);
    if ($delete->rowCount() !== 1) {
        $conn->rollBack();
        deleteResponse(409, false, 'Report could not be archived. Please refresh and try again.');
    }
    $conn->commit();
    deleteResponse(200, true, 'Report archived successfully.');
} catch (PDOException $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawConnect delete_report] Database error: ' . $e->getMessage());
    deleteResponse(500, false, 'Unable to archive report. Please try again.');
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawConnect delete_report] Error: ' . $e->getMessage());
    deleteResponse(500, false, 'Unable to archive report. Please try again.');
}
