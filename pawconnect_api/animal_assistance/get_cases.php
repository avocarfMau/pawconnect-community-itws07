<?php

// =====================================
// PAWRESCUE COMMUNITY
// ANIMAL ASSISTANCE MANAGEMENT
// GET CASES - VETERINARY OFFICE STAFF ONLY
// =====================================
//
// Cases are created by the backend when a resident marks a
// Found Pet report as needing assistance.
//
// CORS / OPTIONS are handled by the project's central cors.php
// and .htaccess configuration, like reports/create_report.php.
//
// Example GET requests:
//   /animal_assistance/get_cases.php
//   /animal_assistance/get_cases.php?status=pending
//   /animal_assistance/get_cases.php?status=under_review&limit=20&offset=0
//   /animal_assistance/get_cases.php?case_id=1
//
// Authorization: Bearer <authenticated staff access token>

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function assistanceResponse(int $httpStatus, bool $success, string $message, array $extra = []): void
{
    http_response_code($httpStatus);
    echo json_encode(
        array_merge([
            'success' => $success,
            'message' => $message
        ], $extra),
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

// OPTIONS is handled centrally before this script is executed.
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    assistanceResponse(405, false, 'Method not allowed.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // IMPORTANT: Do not change this to authenticate() with no roles.
    // Residents must not be able to retrieve staff case information.
    $auth = authenticate(['staff']);
    /** @var PDO $conn */
    $conn = $auth['connection'];

    // =====================================
    // VALIDATE QUERY PARAMETERS
    // =====================================
    $status = $_GET['status'] ?? 'all';
    $allowedStatuses = ['all', 'pending', 'under_review', 'in_progress', 'resolved'];

    if (!is_string($status) || !in_array($status, $allowedStatuses, true)) {
        assistanceResponse(400, false, 'Invalid status filter.');
    }

    $limitRaw = $_GET['limit'] ?? '20';
    $offsetRaw = $_GET['offset'] ?? '0';
    $caseIdRaw = $_GET['case_id'] ?? null;

    if (
        !is_string($limitRaw) ||
        !ctype_digit($limitRaw) ||
        strlen($limitRaw) > 3 ||
        (int) $limitRaw < 1 ||
        (int) $limitRaw > 50
    ) {
        assistanceResponse(400, false, 'Limit must be between 1 and 50.');
    }

    if (
        !is_string($offsetRaw) ||
        !ctype_digit($offsetRaw) ||
        strlen($offsetRaw) > 7 ||
        (int) $offsetRaw > 1000000
    ) {
        assistanceResponse(400, false, 'Invalid offset.');
    }

    $limit = (int) $limitRaw;
    $offset = (int) $offsetRaw;
    $caseId = null;

    if ($caseIdRaw !== null) {
        if (
            !is_string($caseIdRaw) ||
            !ctype_digit($caseIdRaw) ||
            strlen($caseIdRaw) > 10 ||
            (float) $caseIdRaw < 1 ||
            (float) $caseIdRaw > 4294967295
        ) {
            assistanceResponse(400, false, 'Invalid case ID.');
        }

        $caseId = (int) $caseIdRaw;
    }

    // =====================================
    // BUILD FILTERS WITH BOUND PARAMETERS
    // =====================================
    // JOIN includes the Found Pet report and reporter details.
    // The Found Pet and assistance statuses remain independent.
    $fromAndWhere =
        " FROM animal_assistance_cases a
          INNER JOIN pet_reports p
              ON p.id = a.found_report_id
          INNER JOIN users u
              ON u.id = p.user_id
          WHERE p.report_type = 'found'";

    if ($status !== 'all') {
        $fromAndWhere .= ' AND a.status = :status';
    }

    if ($caseId !== null) {
        $fromAndWhere .= ' AND a.id = :case_id';
    }

    // A separate count query makes pagination reliable.
    $countStmt = $conn->prepare('SELECT COUNT(*)' . $fromAndWhere);

    if ($status !== 'all') {
        $countStmt->bindValue(':status', $status, PDO::PARAM_STR);
    }
    if ($caseId !== null) {
        $countStmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    }

    $countStmt->execute();
    $total = (int) $countStmt->fetchColumn();

    // A requested case ID that does not exist should be explicit.
    if ($caseId !== null && $total === 0) {
        assistanceResponse(404, false, 'Animal assistance case not found.');
    }

    // =====================================
    // GET CASES (MOST RECENT FIRST)
    // =====================================
    $sql =
        'SELECT
            a.id,
            a.found_report_id,
            a.assistance_reason,
            a.assistance_details,
            a.status,
            a.staff_notes,
            a.reviewed_at,
            a.resolved_at,
            a.created_at,
            a.updated_at,

            p.report_type,
            p.animal_type,
            p.pet_name,
            p.description,
            p.incident_date,
            p.location_address,
            p.latitude,
            p.longitude,
            p.photo_path,
            p.status AS report_status,
            p.created_at AS report_created_at,

            u.id AS reporter_user_id,
            u.full_name AS reporter_name'
        . $fromAndWhere
        . ' ORDER BY a.created_at DESC, a.id DESC
            LIMIT :limit OFFSET :offset';

    $stmt = $conn->prepare($sql);

    if ($status !== 'all') {
        $stmt->bindValue(':status', $status, PDO::PARAM_STR);
    }
    if ($caseId !== null) {
        $stmt->bindValue(':case_id', $caseId, PDO::PARAM_INT);
    }

    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $cases = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Keep IDs numeric for Angular consumers.
    foreach ($cases as &$case) {
        $case['id'] = (int) $case['id'];
        $case['found_report_id'] = (int) $case['found_report_id'];
        $case['reporter_user_id'] = (int) $case['reporter_user_id'];
        $case['latitude'] = $case['latitude'] !== null
            ? (float) $case['latitude'] : null;
        $case['longitude'] = $case['longitude'] !== null
            ? (float) $case['longitude'] : null;
    }
    unset($case);

    assistanceResponse(200, true, 'Animal assistance cases retrieved successfully.', [
        'status_filter' => $status,
        'total' => $total,
        'count' => count($cases),
        'limit' => $limit,
        'offset' => $offset,
        'has_more' => $offset + count($cases) < $total,
        'cases' => $cases
    ]);

} catch (Throwable $e) {
    // Do not expose SQL or server configuration details to the client.
    error_log('[PawRescue Animal Assistance Get Cases] ' . $e->getMessage());
    assistanceResponse(500, false, 'Unable to retrieve assistance cases. Please try again.');
}
