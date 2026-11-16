<?php
// ============================================================
// PAWCONNECT - ANIMAL ASSISTANCE CASE MANAGEMENT
// File: pawconnect_api/animal_assistance/update_case.php
// Staff-only endpoint: update an existing assistance case.
// ============================================================
//
// POST /animal_assistance/update_case.php
// Authorization: Bearer <staff access token>
// Content-Type: application/json
//
// Example body:
// {
//   "case_id": 12,
//   "status": "under_review",
//   "staff_note": "Reviewed the Found Pet report and attached photo."
// }
//
// Status progression:
// pending -> under_review -> in_progress -> resolved
//
// A case can stay at its current status when adding a note.
// A resolution note is required when moving to "resolved".
// The linked Found Pet report remains unchanged.
// CORS/OPTIONS are handled centrally by the existing project setup.
// ============================================================

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendCaseUpdateResponse(int $httpStatus, bool $success, string $message, array $extra = []): void
{
    http_response_code($httpStatus);
    echo json_encode(
        array_merge([
            'success' => $success,
            'message' => $message,
        ], $extra),
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendCaseUpdateResponse(405, false, 'Method not allowed.');
}

if (!preg_match('~^application/json(?:\s*;|\s*$)~i', trim((string) ($_SERVER['CONTENT_TYPE'] ?? '')))) {
    sendCaseUpdateResponse(415, false, 'Content-Type must be application/json.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

/** @var PDO|null $conn */
$conn = null;

try {
    // The backend enforces staff-only access independently of Angular routing.
    $auth = authenticate(['staff']);
    $conn = $auth['connection'];
    $staffName = trim((string) ($auth['user']['full_name'] ?? ''));
    if ($staffName === '') {
        $staffName = 'Municipal Veterinary Office Staff';
    }

    // Accept a small JSON request only (prevents unbounded note payloads).
    $raw = file_get_contents('php://input', false, null, 0, 8193);
    if ($raw === false || strlen($raw) > 8192) {
        sendCaseUpdateResponse(413, false, 'Request is too large.');
    }

    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
        sendCaseUpdateResponse(400, false, 'Invalid JSON request.');
    }

    // The database schema uses an unsigned INT primary key.
    $caseId = $data['case_id'] ?? null;
    if (!is_int($caseId) || $caseId < 1 || $caseId > 4294967295) {
        sendCaseUpdateResponse(400, false, 'A valid numeric case_id is required.');
    }

    $status = $data['status'] ?? null;
    $allowedStatuses = ['pending', 'under_review', 'in_progress', 'resolved'];
    if (!is_string($status) || !in_array($status, $allowedStatuses, true)) {
        sendCaseUpdateResponse(400, false, 'Invalid assistance case status.');
    }

    $staffNote = $data['staff_note'] ?? '';
    if (!is_string($staffNote)) {
        sendCaseUpdateResponse(400, false, 'Staff note must be text.');
    }
    $staffNote = trim($staffNote);
    if (mb_strlen($staffNote, 'UTF-8') > 2000) {
        sendCaseUpdateResponse(400, false, 'Staff note must be 2000 characters or fewer.');
    }

    // Serialize competing edits of the same case.
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $conn->beginTransaction();

    $selectStmt = $conn->prepare(
        "SELECT a.id, a.found_report_id, a.status, a.staff_notes
         FROM animal_assistance_cases a
         INNER JOIN pet_reports p ON p.id = a.found_report_id
         WHERE a.id = :case_id AND p.report_type = 'found'
         LIMIT 1
         FOR UPDATE"
    );
    $selectStmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    $selectStmt->execute();
    $case = $selectStmt->fetch(PDO::FETCH_ASSOC);

    if (!$case) {
        $conn->rollBack();
        sendCaseUpdateResponse(404, false, 'Animal assistance case not found.');
    }

    $previousStatus = (string) $case['status'];
    $nextStatusByCurrent = [
        'pending' => 'under_review',
        'under_review' => 'in_progress',
        'in_progress' => 'resolved',
        'resolved' => null,
    ];

    if (!array_key_exists($previousStatus, $nextStatusByCurrent)) {
        $conn->rollBack();
        sendCaseUpdateResponse(409, false, 'Case has an unsupported current status.');
    }

    $statusChanged = $status !== $previousStatus;
    if ($statusChanged && $status !== $nextStatusByCurrent[$previousStatus]) {
        $conn->rollBack();
        sendCaseUpdateResponse(
            409,
            false,
            'Invalid status change. Follow Pending, Under Review, In Progress, then Resolved.',
            ['current_status' => $previousStatus]
        );
    }

    if (!$statusChanged && $staffNote === '') {
        $conn->rollBack();
        sendCaseUpdateResponse(400, false, 'Enter a staff note or select the next status.');
    }

    if ($statusChanged && $status === 'resolved' && $staffNote === '') {
        $conn->rollBack();
        sendCaseUpdateResponse(400, false, 'A resolution note is required before resolving a case.');
    }

    // Retain prior notes. Existing schema has a TEXT column rather than
    // a separate immutable activity-log table.
    $labels = [
        'pending' => 'Pending',
        'under_review' => 'Under Review',
        'in_progress' => 'In Progress',
        'resolved' => 'Resolved',
    ];
    $action = $statusChanged
        ? 'Status changed: ' . $labels[$previousStatus] . ' -> ' . $labels[$status]
        : 'Assessment note added (' . $labels[$status] . ')';

    if ($staffNote !== '') {
        $action .= "\n" . $staffNote;
    }

    $entry = '[' . gmdate('Y-m-d H:i:s') . ' UTC] ' . $staffName . "\n" . $action;
    $existingNotes = (string) ($case['staff_notes'] ?? '');
    $combinedNotes = $existingNotes === '' ? $entry : $existingNotes . "\n\n" . $entry;

    // MySQL TEXT has a 65,535-byte limit; do not silently erase or truncate history.
    if (strlen($combinedNotes) > 60000) {
        $conn->rollBack();
        sendCaseUpdateResponse(409, false, 'Case notes have reached the storage limit. Contact an administrator.');
    }

    $updateStmt = $conn->prepare(
        'UPDATE animal_assistance_cases
         SET status = :status,
             staff_notes = :notes,
             reviewed_at = CASE
                WHEN :mark_reviewed = 1 THEN COALESCE(reviewed_at, CURRENT_TIMESTAMP)
                ELSE reviewed_at
             END,
             resolved_at = CASE
                WHEN :mark_resolved = 1 THEN COALESCE(resolved_at, CURRENT_TIMESTAMP)
                ELSE resolved_at
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = :case_id'
    );
    $updateStmt->bindValue(':status', $status, PDO::PARAM_STR);
    $updateStmt->bindValue(':notes', $combinedNotes, PDO::PARAM_STR);
    $updateStmt->bindValue(':mark_reviewed', $status !== 'pending' ? 1 : 0, PDO::PARAM_INT);
    $updateStmt->bindValue(':mark_resolved', $status === 'resolved' ? 1 : 0, PDO::PARAM_INT);
    $updateStmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    $updateStmt->execute();

    $resultStmt = $conn->prepare(
        'SELECT id, found_report_id, status, staff_notes, reviewed_at, resolved_at, updated_at
         FROM animal_assistance_cases WHERE id = :case_id LIMIT 1'
    );
    $resultStmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    $resultStmt->execute();
    $result = $resultStmt->fetch(PDO::FETCH_ASSOC);

    $conn->commit();

    sendCaseUpdateResponse(200, true, 'Animal assistance case updated successfully.', [
        'case' => [
            'id' => (int) $result['id'],
            'found_report_id' => (int) $result['found_report_id'],
            'previous_status' => $previousStatus,
            'status' => $result['status'],
            'staff_notes' => $result['staff_notes'],
            'reviewed_at' => $result['reviewed_at'],
            'resolved_at' => $result['resolved_at'],
            'updated_at' => $result['updated_at'],
        ],
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        try {
            $conn->rollBack();
        } catch (Throwable $rollbackError) {
            error_log('[PawConnect Assistance Rollback] ' . $rollbackError->getMessage());
        }
    }

    error_log('[PawConnect Assistance Update] ' . $e->getMessage());
    sendCaseUpdateResponse(500, false, 'Unable to update assistance case. Please try again.');
}
