<?php
// ============================================================
// PAWCONNECT - ANIMAL ASSISTANCE CASE MANAGEMENT
// File: pawconnect_api/animal_assistance/update_case.php
// Staff-only endpoint: save an assessment note or confirm rescue.
// ============================================================
//
// POST /animal_assistance/update_case.php
// Authorization: Bearer <staff access token>
//
// For ordinary notes: Content-Type: application/json
//   {"case_id":12,"status":"pending","staff_note":"Checked report."}
//
// For a rescue: Content-Type: multipart/form-data (FormData)
//   case_id:       12
//   status:        rescued
//   staff_note:    Animal safely rescued and transferred for care.
//   rescue_proof:  one JPG, PNG, or WEBP photo (maximum 5 MB)
//
// New case progression: Pending -> Rescued (proof + note required).
// Older Under Review / In Progress cases may also be completed as Rescued.
// Historical Resolved cases remain unchanged; follow-up notes are allowed.
// The linked Found Pet report is never changed by this endpoint.
// Existing CORS/OPTIONS behavior is handled by the project's middleware.
// ============================================================

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const MAX_RESCUE_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_REQUEST_BYTES = 7 * 1024 * 1024;

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

$contentType = trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
$isJson = (bool) preg_match('~^application/json(?:\s*;|\s*$)~i', $contentType);
$isMultipart = (bool) preg_match('~^multipart/form-data(?:\s*;|\s*$)~i', $contentType);

if (!$isJson && !$isMultipart) {
    sendCaseUpdateResponse(415, false, 'Content-Type must be application/json or multipart/form-data.');
}

if ($isMultipart && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_MULTIPART_REQUEST_BYTES) {
    sendCaseUpdateResponse(413, false, 'Rescue proof request is too large (maximum photo size is 5 MB).');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

/** @var PDO|null $conn */
$conn = null;
/** @var string|null $newProofFilePath */
$newProofFilePath = null;

try {
    // The backend enforces staff-only access independently of Angular routing.
    $auth = authenticate(['staff']);
    $conn = $auth['connection'];

    $staffName = trim((string) ($auth['user']['full_name'] ?? ''));
    if ($staffName === '') {
        $staffName = 'Municipal Veterinary Office Staff';
    }

    $staffUserId = filter_var(
        $auth['user']['id'] ?? null,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );
    if ($staffUserId === false || $staffUserId === null) {
        sendCaseUpdateResponse(401, false, 'Unable to identify the authenticated staff account.');
    }

    // Keep JSON support for note-only submissions from the existing frontend.
    // A rescue requires multipart/form-data, so PHP can validate $_FILES.
    if ($isJson) {
        $raw = file_get_contents('php://input', false, null, 0, 8193);
        if ($raw === false || strlen($raw) > 8192) {
            sendCaseUpdateResponse(413, false, 'Request is too large.');
        }

        $data = json_decode($raw, true);
        if (json_last_error() !== JSON_ERROR_NONE || !is_array($data) || array_is_list($data)) {
            sendCaseUpdateResponse(400, false, 'Invalid JSON request.');
        }
    } else {
        // When post_max_size is exceeded, PHP may leave both arrays empty.
        if (empty($_POST) && empty($_FILES)) {
            sendCaseUpdateResponse(413, false, 'No form fields received. Check PHP post_max_size.');
        }
        $data = $_POST;
    }

    $caseIdValue = $data['case_id'] ?? null;
    if ($isMultipart && is_string($caseIdValue) && ctype_digit($caseIdValue)) {
        $caseIdValue = (int) $caseIdValue;
    }
    if (!is_int($caseIdValue) || $caseIdValue < 1 || $caseIdValue > 4294967295) {
        sendCaseUpdateResponse(400, false, 'A valid numeric case_id is required.');
    }
    $caseId = $caseIdValue;

    $status = $data['status'] ?? null;
    $allowedStatuses = ['pending', 'under_review', 'in_progress', 'resolved', 'rescued'];
    if (!is_string($status) || !in_array($status, $allowedStatuses, true)) {
        sendCaseUpdateResponse(400, false, 'Invalid assistance case status.');
    }

    $staffNote = $data['staff_note'] ?? '';
    if (!is_string($staffNote)) {
        sendCaseUpdateResponse(400, false, 'Assistance note must be text.');
    }
    $staffNote = trim($staffNote);
    if (mb_strlen($staffNote, 'UTF-8') > 2000) {
        sendCaseUpdateResponse(400, false, 'Assistance note must be 2000 characters or fewer.');
    }

    $photoField = $_FILES['rescue_proof'] ?? null;
    if ($photoField !== null && (!is_array($photoField) || is_array($photoField['name'] ?? null))) {
        sendCaseUpdateResponse(400, false, 'Only one rescue proof photo can be uploaded.');
    }
    if ($isMultipart && count($_FILES) > ($photoField === null ? 0 : 1)) {
        sendCaseUpdateResponse(400, false, 'Unexpected file field. Use rescue_proof for the photo.');
    }

    // Lock the case so two staff updates cannot overwrite one another.
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $conn->beginTransaction();

    $selectStmt = $conn->prepare(
        "SELECT a.id, a.found_report_id, a.status, a.staff_notes, a.rescue_proof_path
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
    $legacyStatuses = ['under_review', 'in_progress'];
    $knownStatuses = ['pending', 'under_review', 'in_progress', 'resolved', 'rescued'];
    if (!in_array($previousStatus, $knownStatuses, true)) {
        $conn->rollBack();
        sendCaseUpdateResponse(409, false, 'Case has an unsupported current status.');
    }

    $statusChanged = ($status !== $previousStatus);
    $isRescueCompletion = $statusChanged && $status === 'rescued';

    // Only Pending -> Rescued is used for new cases. Older active case
    // statuses are supported solely to finish records without data loss.
    if ($statusChanged && (!$isRescueCompletion ||
        (!($previousStatus === 'pending' || in_array($previousStatus, $legacyStatuses, true))))) {
        $conn->rollBack();
        sendCaseUpdateResponse(409, false, 'Invalid status change. An active case may only move to Rescued.', [
            'current_status' => $previousStatus,
        ]);
    }

    if (!$statusChanged && $staffNote === '') {
        $conn->rollBack();
        sendCaseUpdateResponse(400, false, 'Enter an assistance note or select Rescued.');
    }

    if ($isRescueCompletion && $staffNote === '') {
        $conn->rollBack();
        sendCaseUpdateResponse(400, false, 'Describe the rescue or assistance provided before marking this case Rescued.');
    }

    // A brand-new rescue must have an image. Never allow existing or
    // previously uploaded images to substitute for new completion proof.
    if ($isRescueCompletion) {
        if (!$isMultipart) {
            $conn->rollBack();
            sendCaseUpdateResponse(400, false, 'Upload a rescue proof photo using multipart/form-data.');
        }
        if ($photoField === null || (int) ($photoField['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            $conn->rollBack();
            sendCaseUpdateResponse(400, false, 'A rescue proof photo is required before marking a case Rescued.');
        }
    } elseif ($photoField !== null && (int) ($photoField['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
        $conn->rollBack();
        sendCaseUpdateResponse(400, false, 'Rescue proof photos can only be uploaded when completing a rescue.');
    }

    $relativeProofPath = null;
    if ($isRescueCompletion) {
        $uploadError = (int) ($photoField['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($uploadError !== UPLOAD_ERR_OK) {
            $conn->rollBack();
            sendCaseUpdateResponse(
                $uploadError === UPLOAD_ERR_INI_SIZE || $uploadError === UPLOAD_ERR_FORM_SIZE ? 413 : 400,
                false,
                'The rescue proof upload failed. Use a JPG, PNG, or WEBP photo under 5 MB.'
            );
        }

        $tmpName = $photoField['tmp_name'] ?? '';
        $size = $photoField['size'] ?? null;
        if (!is_string($tmpName) || !is_uploaded_file($tmpName) ||
            !is_int($size) || $size <= 0 || $size > MAX_RESCUE_PROOF_BYTES) {
            $conn->rollBack();
            sendCaseUpdateResponse(400, false, 'The rescue proof photo is invalid or exceeds 5 MB.');
        }

        $mimeType = (new finfo(FILEINFO_MIME_TYPE))->file($tmpName);
        $imageInfo = @getimagesize($tmpName);
        $acceptedImages = [
            'image/jpeg' => ['extension' => 'jpg', 'type' => IMAGETYPE_JPEG],
            'image/png' => ['extension' => 'png', 'type' => IMAGETYPE_PNG],
            'image/webp' => ['extension' => 'webp', 'type' => IMAGETYPE_WEBP],
        ];
        if (!is_string($mimeType) || !isset($acceptedImages[$mimeType]) ||
            !is_array($imageInfo) || ($imageInfo[2] ?? null) !== $acceptedImages[$mimeType]['type']) {
            $conn->rollBack();
            sendCaseUpdateResponse(400, false, 'Rescue proof must be a valid JPG, PNG, or WEBP image.');
        }

        // Upload into the existing PHP API's uploads directory. Use a server-
        // generated filename; never use the client's filename or a URL.
        $uploadDirectory = __DIR__ . '/../uploads/rescue_proofs';
        if (!is_dir($uploadDirectory) && !mkdir($uploadDirectory, 0755, true) && !is_dir($uploadDirectory)) {
            throw new RuntimeException('Unable to create rescue proof upload directory.');
        }

        $filename = bin2hex(random_bytes(16)) . '.' . $acceptedImages[$mimeType]['extension'];
        $newProofFilePath = $uploadDirectory . '/' . $filename;
        if (!move_uploaded_file($tmpName, $newProofFilePath)) {
            $newProofFilePath = null;
            throw new RuntimeException('Unable to save uploaded rescue proof image.');
        }
        $relativeProofPath = 'uploads/rescue_proofs/' . $filename;
    }

    // Retain historical assessment notes; append new activity.
    $labels = [
        'pending' => 'Pending',
        'under_review' => 'Under Review',
        'in_progress' => 'In Progress',
        'resolved' => 'Resolved',
        'rescued' => 'Rescued',
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

    // MySQL TEXT can hold at most 65,535 bytes; avoid truncating notes.
    if (strlen($combinedNotes) > 60000) {
        $conn->rollBack();
        if ($newProofFilePath !== null && is_file($newProofFilePath)) {
            unlink($newProofFilePath);
        }
        sendCaseUpdateResponse(409, false, 'Case notes have reached the storage limit. Contact an administrator.');
    }

    $updateStmt = $conn->prepare(
        'UPDATE animal_assistance_cases
         SET status = :status,
             staff_notes = :notes,
             rescue_proof_path = CASE
                 WHEN :mark_rescued = 1 THEN :rescue_proof_path
                 ELSE rescue_proof_path
             END,
             rescue_note = CASE
                 WHEN :mark_rescued_note = 1 THEN :rescue_note
                 ELSE rescue_note
             END,
             rescued_at = CASE
                 WHEN :mark_rescued_time = 1 THEN COALESCE(rescued_at, CURRENT_TIMESTAMP)
                 ELSE rescued_at
             END,
             rescued_by_user_id = CASE
                 WHEN :mark_rescued_by = 1 THEN :rescued_by_user_id
                 ELSE rescued_by_user_id
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = :case_id'
    );
    $updateStmt->bindValue(':status', $status, PDO::PARAM_STR);
    $updateStmt->bindValue(':notes', $combinedNotes, PDO::PARAM_STR);
    $updateStmt->bindValue(':mark_rescued', $isRescueCompletion ? 1 : 0, PDO::PARAM_INT);
    $updateStmt->bindValue(':rescue_proof_path', $relativeProofPath, $relativeProofPath === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
    $updateStmt->bindValue(':mark_rescued_note', $isRescueCompletion ? 1 : 0, PDO::PARAM_INT);
    $updateStmt->bindValue(':rescue_note', $isRescueCompletion ? $staffNote : null,
        $isRescueCompletion ? PDO::PARAM_STR : PDO::PARAM_NULL);
    $updateStmt->bindValue(':mark_rescued_time', $isRescueCompletion ? 1 : 0, PDO::PARAM_INT);
    $updateStmt->bindValue(':mark_rescued_by', $isRescueCompletion ? 1 : 0, PDO::PARAM_INT);
    $updateStmt->bindValue(':rescued_by_user_id', $isRescueCompletion ? $staffUserId : null,
        $isRescueCompletion ? PDO::PARAM_INT : PDO::PARAM_NULL);
    $updateStmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    $updateStmt->execute();

    $resultStmt = $conn->prepare(
        'SELECT id, found_report_id, status, staff_notes, reviewed_at, resolved_at,
                rescue_proof_path, rescue_note, rescued_at, rescued_by_user_id, updated_at
         FROM animal_assistance_cases WHERE id = :case_id LIMIT 1'
    );
    $resultStmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    $resultStmt->execute();
    $result = $resultStmt->fetch(PDO::FETCH_ASSOC);
    if (!$result) {
        throw new RuntimeException('Updated assistance case could not be reloaded.');
    }

    $conn->commit();

    sendCaseUpdateResponse(200, true, $isRescueCompletion
        ? 'Animal rescue recorded successfully.'
        : 'Animal assistance case updated successfully.', [
        'case' => [
            'id' => (int) $result['id'],
            'found_report_id' => (int) $result['found_report_id'],
            'previous_status' => $previousStatus,
            'status' => $result['status'],
            'staff_notes' => $result['staff_notes'],
            'reviewed_at' => $result['reviewed_at'],
            'resolved_at' => $result['resolved_at'],
            'rescue_proof_path' => $result['rescue_proof_path'],
            'rescue_note' => $result['rescue_note'],
            'rescued_at' => $result['rescued_at'],
            'rescued_by_user_id' => $result['rescued_by_user_id'] === null ? null : (int) $result['rescued_by_user_id'],
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

    // An uncommitted rescue must not leave an orphaned proof photo.
    if ($newProofFilePath !== null && is_file($newProofFilePath)) {
        @unlink($newProofFilePath);
    }

    error_log('[PawConnect Assistance Update] ' . $e->getMessage());
    sendCaseUpdateResponse(500, false, 'Unable to update assistance case. Please try again.');
}
