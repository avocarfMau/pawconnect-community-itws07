<?php
// ============================================================
// PAWCONNECT — BARANGAY STAFF (STAFF ONLY)
// MY ASSISTED CASES API
//
// Place this file in the SAME folder as the working get_cases.php:
// pawconnect_api/animal_assistance/get_my_assisted_cases.php
//
// GET /animal_assistance/get_my_assisted_cases.php?limit=20&offset=0
// Authorization: Bearer <staff token>
//
// Returns only rescued cases completed by the authenticated staff user.
// Staff identity comes from the access token, not from client parameters.
// Project CORS and OPTIONS handling is shared with get_cases.php.
// ============================================================

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendMyAssistedResponse(
    int $statusCode,
    bool $success,
    string $message,
    array $extra = []
): void {
    http_response_code($statusCode);
    echo json_encode(
        array_merge([
            'success' => $success,
            'message' => $message,
        ], $extra),
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

// The application's central CORS configuration handles OPTIONS preflight
// before this script, just as it does for the working get_cases.php.
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    sendMyAssistedResponse(405, false, 'Method not allowed.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    $auth = authenticate(['staff']);
    /** @var PDO $conn */
    $conn = $auth['connection'];
    $staffId = (int) ($auth['user']['id'] ?? 0);

    if ($staffId <= 0) {
        sendMyAssistedResponse(401, false, 'Invalid staff session.');
    }

    $limitRaw = $_GET['limit'] ?? '20';
    $offsetRaw = $_GET['offset'] ?? '0';

    if (
        !is_string($limitRaw) ||
        !ctype_digit($limitRaw) ||
        strlen($limitRaw) > 3 ||
        (int) $limitRaw < 1 ||
        (int) $limitRaw > 50
    ) {
        sendMyAssistedResponse(400, false, 'Limit must be between 1 and 50.');
    }

    if (
        !is_string($offsetRaw) ||
        !ctype_digit($offsetRaw) ||
        strlen($offsetRaw) > 7 ||
        (int) $offsetRaw > 1000000
    ) {
        sendMyAssistedResponse(400, false, 'Invalid offset.');
    }

    $limit = (int) $limitRaw;
    $offset = (int) $offsetRaw;

    $fromAndWhere =
        " FROM animal_assistance_cases a
          INNER JOIN pet_reports p
              ON p.id = a.found_report_id
          INNER JOIN users u
              ON u.id = p.user_id
          WHERE p.report_type = 'found'
            AND a.status = 'rescued'
            AND a.rescued_by_user_id = :staff_id";

    // Total across every page, but only for this staff member's rescues.
    $countStmt = $conn->prepare('SELECT COUNT(*)' . $fromAndWhere);
    $countStmt->bindValue(':staff_id', $staffId, PDO::PARAM_INT);
    $countStmt->execute();
    $total = (int) $countStmt->fetchColumn();

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
            a.rescue_proof_path,
            a.rescue_note,
            a.rescued_at,
            a.rescued_by_user_id,
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
        . ' ORDER BY a.rescued_at DESC, a.id DESC
            LIMIT :limit OFFSET :offset';

    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':staff_id', $staffId, PDO::PARAM_INT);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $cases = $stmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($cases as &$case) {
        $case['id'] = (int) $case['id'];
        $case['found_report_id'] = (int) $case['found_report_id'];
        $case['reporter_user_id'] = (int) $case['reporter_user_id'];
        $case['rescued_by_user_id'] = $case['rescued_by_user_id'] === null
            ? null
            : (int) $case['rescued_by_user_id'];
        $case['latitude'] = $case['latitude'] === null
            ? null
            : (float) $case['latitude'];
        $case['longitude'] = $case['longitude'] === null
            ? null
            : (float) $case['longitude'];
    }
    unset($case);

    sendMyAssistedResponse(
        200,
        true,
        'Your rescued animal assistance cases were retrieved successfully.',
        [
            'total' => $total,
            'count' => count($cases),
            'limit' => $limit,
            'offset' => $offset,
            'has_more' => $offset + count($cases) < $total,
            'cases' => $cases,
        ]
    );
} catch (Throwable $e) {
    error_log('[PawConnect My Assisted Cases] ' . $e->getMessage());
    sendMyAssistedResponse(500, false, 'Unable to retrieve your assisted cases. Please try again.');
}
