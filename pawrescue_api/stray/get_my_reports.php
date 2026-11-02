<?php
// ============================================================
// PAWRESCUE COMMUNITY - MY STRAY ANIMAL REPORTS
// Save as: pawrescue_api/stray/get_my_reports.php
// ============================================================
// Uses the existing .htaccess / cors.php configuration.
// This endpoint NEVER accepts a resident ID from the client.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function sendStrayReportsResponse(int $status, bool $success, string $message, array $extra = []): void
{
    http_response_code($status);
    echo json_encode(array_merge([
        'success' => $success,
        'message' => $message,
    ], $extra), JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// OPTIONS is handled by your centralized CORS configuration.
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    sendStrayReportsResponse(405, false, 'Method not allowed.');
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // Only an authenticated resident may see their own reports.
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $userId = (int) $auth['user']['id'];

    // Optional pagination: limit=1..50, offset=0 or greater.
    $limitInput = $_GET['limit'] ?? '20';
    $offsetInput = $_GET['offset'] ?? '0';

    if (!is_string($limitInput) || !ctype_digit($limitInput) || strlen($limitInput) > 3 ||
        !is_string($offsetInput) || !ctype_digit($offsetInput) || strlen($offsetInput) > 9) {
        sendStrayReportsResponse(400, false, 'Invalid pagination parameters.');
    }

    $limit = (int) $limitInput;
    $offset = (int) $offsetInput;
    if ($limit < 1 || $limit > 50) {
        sendStrayReportsResponse(400, false, 'Limit must be between 1 and 50.');
    }

    // Count only the current resident's reports.
    $countStmt = $conn->prepare(
        'SELECT COUNT(*) FROM stray_reports WHERE user_id = :user_id'
    );
    $countStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $countStmt->execute();
    $total = (int) $countStmt->fetchColumn();

    // Load the newest reports, scoped to the authenticated user.
    $stmt = $conn->prepare(
        'SELECT id, animal_type, assistance_reason, description,
                incident_date, location_address, latitude, longitude,
                status, resolved_at, created_at, updated_at
         FROM stray_reports
         WHERE user_id = :user_id
         ORDER BY created_at DESC, id DESC
         LIMIT :page_limit OFFSET :page_offset'
    );
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':page_limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':page_offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $reports = [];
    $reportPositions = [];
    $reportIds = [];

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $record) {
        $id = (int) $record['id'];
        $reportPositions[$id] = count($reports);
        $reportIds[] = $id;

        $reports[] = [
            'id' => $id,
            'animal_type' => $record['animal_type'],
            'assistance_reason' => $record['assistance_reason'],
            'description' => $record['description'],
            'incident_date' => $record['incident_date'],
            'location_address' => $record['location_address'],
            'latitude' => $record['latitude'] === null ? null : (float) $record['latitude'],
            'longitude' => $record['longitude'] === null ? null : (float) $record['longitude'],
            'status' => $record['status'],
            'resolved_at' => $record['resolved_at'],
            'created_at' => $record['created_at'],
            'updated_at' => $record['updated_at'],
            'photos' => [],
            'photo_count' => 0,
            'cover_photo_url' => null,
        ];
    }

    // Retrieve photos in one query for the entire page.
    // Only report IDs from the authenticated resident's query are used.
    if (!empty($reportIds)) {
        $placeholders = implode(', ', array_fill(0, count($reportIds), '?'));
        $photoStmt = $conn->prepare(
            'SELECT id, stray_report_id, photo_path, sort_order, created_at
             FROM stray_report_photos
             WHERE stray_report_id IN (' . $placeholders . ')
             ORDER BY stray_report_id ASC, sort_order ASC, id ASC'
        );

        foreach ($reportIds as $index => $reportId) {
            $photoStmt->bindValue($index + 1, $reportId, PDO::PARAM_INT);
        }
        $photoStmt->execute();

        // Example: /pawrescue-community-itws07/pawrescue_api
        // This is a same-origin URL path, not a hardcoded LAN IP.
        $scriptName = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '');
        $apiPath = rtrim(str_replace('\\', '/', dirname(dirname($scriptName))), '/');

        foreach ($photoStmt->fetchAll(PDO::FETCH_ASSOC) as $photo) {
            $reportId = (int) $photo['stray_report_id'];
            if (!isset($reportPositions[$reportId])) {
                continue;
            }

            // The existing uploader generates 32-hex-character filenames.
            // Reject unexpected stored paths rather than exposing arbitrary files.
            $filename = basename(str_replace('\\', '/', (string) $photo['photo_path']));
            if (!preg_match('/^[a-f0-9]{32}\.(jpg|png|webp)$/i', $filename)) {
                error_log('[PawRescue My Stray Reports] Unexpected photo filename for report ' . $reportId);
                continue;
            }

            $photoUrl = $apiPath . '/uploads/strays/' . rawurlencode($filename);
            $position = $reportPositions[$reportId];

            $reports[$position]['photos'][] = [
                'id' => (int) $photo['id'],
                'photo_url' => $photoUrl,
                'sort_order' => (int) $photo['sort_order'],
                'created_at' => $photo['created_at'],
            ];

            if ($reports[$position]['cover_photo_url'] === null) {
                $reports[$position]['cover_photo_url'] = $photoUrl;
            }
            $reports[$position]['photo_count']++;
        }
    }

    sendStrayReportsResponse(200, true, 'Stray reports retrieved successfully.', [
        'reports' => $reports,
        'total' => $total,
        'limit' => $limit,
        'offset' => $offset,
        'has_more' => $offset + count($reports) < $total,
    ]);
} catch (Throwable $e) {
    error_log('[PawRescue Get My Stray Reports] ' . $e->getMessage());
    sendStrayReportsResponse(500, false, 'Unable to load stray reports. Please try again.');
}
