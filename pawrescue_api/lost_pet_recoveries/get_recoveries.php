<?php
// ============================================================
// PAWRESCUE COMMUNITY — GET LOST PET RECOVERY SUBMISSIONS
// STEP 54
// File: pawrescue_api/lost_pet_recoveries/get_recoveries.php
// ============================================================
// GET (Authorization: Bearer <resident token>):
//   ?scope=sent
//     Finder B: recovery submissions THEY sent.
//   ?scope=received
//     Owner A: recovery submissions to THEIR Lost Pet posts.
//
// Optional filters:
//   &lost_report_id=123
//   &recovery_id=456
//   &limit=20&offset=0      (limit 1..50, offset 0..1000000)
//
// Examples:
//   get_recoveries.php?scope=sent
//   get_recoveries.php?scope=received&lost_report_id=123
//   get_recoveries.php?scope=sent&recovery_id=456
//
// This is an AUTHENTICATED, PRIVATE endpoint. It returns finding
// details, pickup arrangements, and private photo IDs only.
// To show actual photos, send an authenticated GET to
// view_recovery_photo.php?photo_id=<id> (responseType: blob).
// NEVER expose this response through the public pet feed.
// CORS and OPTIONS are handled by the shared backend config.
// Requires the Step 50 database migration.
// ============================================================

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendRecoveryListResponse(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    sendRecoveryListResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

// ============================================================
// 1. VALIDATE SCOPE AND OPTIONAL QUERY PARAMETERS
// ============================================================
$scope = $_GET['scope'] ?? 'sent';
if (!is_string($scope) || !in_array($scope, ['sent', 'received'], true)) {
    sendRecoveryListResponse(400, [
        'success' => false,
        'message' => 'Scope must be sent or received.'
    ]);
}

function getRecoveryPositiveId(string $name): ?int
{
    if (!array_key_exists($name, $_GET)) {
        return null;
    }

    $raw = $_GET[$name];
    if (!is_string($raw) || !preg_match('/^[1-9][0-9]*$/D', $raw)) {
        sendRecoveryListResponse(400, [
            'success' => false,
            'message' => 'Invalid ' . $name . '.'
        ]);
    }

    $id = filter_var($raw, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1]
    ]);
    if ($id === false) {
        sendRecoveryListResponse(400, [
            'success' => false,
            'message' => 'Invalid ' . $name . '.'
        ]);
    }
    return $id;
}

$lostReportId = getRecoveryPositiveId('lost_report_id');
$recoveryId = getRecoveryPositiveId('recovery_id');

$limit = 20;
if (array_key_exists('limit', $_GET)) {
    $value = getRecoveryPositiveId('limit');
    if ($value === null || $value > 50) {
        sendRecoveryListResponse(400, [
            'success' => false,
            'message' => 'Limit must be between 1 and 50.'
        ]);
    }
    $limit = $value;
}

$offset = 0;
if (array_key_exists('offset', $_GET)) {
    $raw = $_GET['offset'];
    if (!is_string($raw) || !preg_match('/^(0|[1-9][0-9]*)$/D', $raw)) {
        sendRecoveryListResponse(400, [
            'success' => false,
            'message' => 'Offset must be a non-negative integer.'
        ]);
    }
    $value = filter_var($raw, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 0]
    ]);
    if ($value === false || $value > 1000000) {
        sendRecoveryListResponse(400, [
            'success' => false,
            'message' => 'Invalid offset.'
        ]);
    }
    $offset = $value;
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // ========================================================
    // 2. AUTHENTICATE: ID MUST COME FROM THE VERIFIED TOKEN
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $residentId <= 0) {
        throw new RuntimeException('Incomplete authenticated resident session.');
    }

    // The owner/finder access rule applies to BOTH the count and
    // detail queries. A user cannot access another user's records
    // by changing recovery_id or lost_report_id.
    $where = "p.report_type = 'lost'";
    if ($scope === 'received') {
        $where .= ' AND p.user_id = :resident_id';
    } else {
        $where .= ' AND r.finder_user_id = :resident_id';
    }

    $params = [':resident_id' => $residentId];
    if ($lostReportId !== null) {
        $where .= ' AND r.lost_report_id = :lost_report_id';
        $params[':lost_report_id'] = $lostReportId;
    }
    if ($recoveryId !== null) {
        $where .= ' AND r.id = :recovery_id';
        $params[':recovery_id'] = $recoveryId;
    }

    $from = ' FROM pet_lost_recovery_reports AS r
              INNER JOIN pet_reports AS p
                  ON p.id = r.lost_report_id ';

    // ========================================================
    // 3. COUNT ACCESSIBLE RECORDS FOR PAGINATION
    // ========================================================
    $countStmt = $conn->prepare('SELECT COUNT(*)' . $from . ' WHERE ' . $where);
    foreach ($params as $placeholder => $value) {
        $countStmt->bindValue($placeholder, $value, PDO::PARAM_INT);
    }
    $countStmt->execute();
    $total = (int) $countStmt->fetchColumn();

    if ($recoveryId !== null && $total === 0) {
        // Do not reveal whether an inaccessible recovery exists.
        sendRecoveryListResponse(404, [
            'success' => false,
            'message' => 'Recovery submission not found.'
        ]);
    }

    // ========================================================
    // 4. FETCH PRIVATE DETAILS FOR THE CURRENT RESIDENT
    // ========================================================
    $sql = 'SELECT
                r.id,
                r.lost_report_id,
                r.finder_user_id,
                r.linked_found_report_id,
                r.finding_description,
                r.found_location,
                r.found_latitude,
                r.found_longitude,
                r.found_at,
                r.status,
                r.rejection_reason,
                r.cancellation_reason,
                r.dispute_reason,
                r.pickup_location,
                r.pickup_latitude,
                r.pickup_longitude,
                r.pickup_date,
                r.pickup_time,
                r.pickup_timezone,
                r.approved_at,
                r.pickup_confirmed_by_finder_at,
                r.owner_handover_confirmed_at,
                r.finder_handover_confirmed_at,
                r.completed_at,
                r.rejected_at,
                r.cancelled_at,
                r.disputed_at,
                r.created_at,
                r.updated_at,
                p.user_id AS owner_user_id,
                p.pet_name,
                p.animal_type,
                p.status AS lost_report_status,
                owner_user.full_name AS owner_name,
                finder_user.full_name AS finder_name
            ' . $from . '
              INNER JOIN users AS owner_user
                  ON owner_user.id = p.user_id
              INNER JOIN users AS finder_user
                  ON finder_user.id = r.finder_user_id
            WHERE ' . $where . '
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT :limit OFFSET :offset';

    $stmt = $conn->prepare($sql);
    foreach ($params as $placeholder => $value) {
        $stmt->bindValue($placeholder, $value, PDO::PARAM_INT);
    }
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $recoveries = [];
    $recoveryIds = [];

    foreach ($rows as $row) {
        $id = (int) $row['id'];
        $recoveryIds[] = $id;
        $recoveries[$id] = [
            'id' => $id,
            'lost_report_id' => (int) $row['lost_report_id'],
            'lost_report_status' => (string) $row['lost_report_status'],
            'pet_name' => $row['pet_name'],
            'animal_type' => (string) $row['animal_type'],
            'owner_user_id' => (int) $row['owner_user_id'],
            'owner_name' => (string) $row['owner_name'],
            'finder_user_id' => (int) $row['finder_user_id'],
            'finder_name' => (string) $row['finder_name'],
            'linked_found_report_id' => $row['linked_found_report_id'] === null
                ? null : (int) $row['linked_found_report_id'],
            'finding_description' => (string) $row['finding_description'],
            'found_location' => (string) $row['found_location'],
            'found_latitude' => $row['found_latitude'] === null
                ? null : (float) $row['found_latitude'],
            'found_longitude' => $row['found_longitude'] === null
                ? null : (float) $row['found_longitude'],
            'found_at' => $row['found_at'],
            'status' => (string) $row['status'],
            'rejection_reason' => $row['rejection_reason'],
            'cancellation_reason' => $row['cancellation_reason'],
            'dispute_reason' => $row['dispute_reason'],
            'pickup' => [
                'location' => $row['pickup_location'],
                'latitude' => $row['pickup_latitude'] === null
                    ? null : (float) $row['pickup_latitude'],
                'longitude' => $row['pickup_longitude'] === null
                    ? null : (float) $row['pickup_longitude'],
                'date' => $row['pickup_date'],
                'time' => $row['pickup_time'],
                'timezone' => (string) $row['pickup_timezone'],
                'finder_confirmed_at' => $row['pickup_confirmed_by_finder_at']
            ],
            'approved_at' => $row['approved_at'],
            'owner_handover_confirmed_at' => $row['owner_handover_confirmed_at'],
            'finder_handover_confirmed_at' => $row['finder_handover_confirmed_at'],
            'completed_at' => $row['completed_at'],
            'rejected_at' => $row['rejected_at'],
            'cancelled_at' => $row['cancelled_at'],
            'disputed_at' => $row['disputed_at'],
            'created_at' => $row['created_at'],
            'updated_at' => $row['updated_at'],
            // Only metadata; never return a private image file path.
            'evidence_photos' => [],
            'latest_reschedule' => null
        ];
    }

    if ($recoveryIds !== []) {
        // ====================================================
        // 5. BATCH LOAD PRIVATE EVIDENCE PHOTO METADATA
        // ====================================================
        $placeholders = [];
        $idParams = [];
        foreach ($recoveryIds as $index => $id) {
            $key = ':rec_' . $index;
            $placeholders[] = $key;
            $idParams[$key] = $id;
        }
        $inClause = implode(', ', $placeholders);

        $photoStmt = $conn->prepare(
            'SELECT id, recovery_id, sort_order, created_at
             FROM pet_lost_recovery_photos
             WHERE recovery_id IN (' . $inClause . ')
             ORDER BY recovery_id, sort_order, id'
        );
        foreach ($idParams as $key => $id) {
            $photoStmt->bindValue($key, $id, PDO::PARAM_INT);
        }
        $photoStmt->execute();

        while ($photo = $photoStmt->fetch(PDO::FETCH_ASSOC)) {
            $parentId = (int) $photo['recovery_id'];
            if (isset($recoveries[$parentId])) {
                $recoveries[$parentId]['evidence_photos'][] = [
                    'id' => (int) $photo['id'],
                    'sort_order' => (int) $photo['sort_order'],
                    'created_at' => $photo['created_at']
                ];
            }
        }

        // ====================================================
        // 6. BATCH LOAD MOST RECENT PICKUP RESCHEDULE
        // ====================================================
        // Return only the latest reschedule on each recovery.
        // The history stays in the database for future UI support.
        $rescheduleStmt = $conn->prepare(
            'SELECT
                s.id, s.recovery_id, s.requested_by_user_id,
                s.previous_location, s.previous_latitude,
                s.previous_longitude, s.previous_date, s.previous_time,
                s.proposed_location, s.proposed_latitude,
                s.proposed_longitude, s.proposed_date, s.proposed_time,
                s.reason, s.status, s.response_note, s.responded_at,
                s.created_at
             FROM pet_lost_recovery_reschedules AS s
             WHERE s.recovery_id IN (' . $inClause . ')
               AND s.id = (
                   SELECT latest.id
                   FROM pet_lost_recovery_reschedules AS latest
                   WHERE latest.recovery_id = s.recovery_id
                   ORDER BY latest.created_at DESC, latest.id DESC
                   LIMIT 1
               )'
        );
        foreach ($idParams as $key => $id) {
            $rescheduleStmt->bindValue($key, $id, PDO::PARAM_INT);
        }
        $rescheduleStmt->execute();

        while ($reschedule = $rescheduleStmt->fetch(PDO::FETCH_ASSOC)) {
            $parentId = (int) $reschedule['recovery_id'];
            if (!isset($recoveries[$parentId])) {
                continue;
            }
            $recoveries[$parentId]['latest_reschedule'] = [
                'id' => (int) $reschedule['id'],
                'requested_by_user_id' => (int) $reschedule['requested_by_user_id'],
                'previous_location' => $reschedule['previous_location'],
                'previous_latitude' => $reschedule['previous_latitude'] === null
                    ? null : (float) $reschedule['previous_latitude'],
                'previous_longitude' => $reschedule['previous_longitude'] === null
                    ? null : (float) $reschedule['previous_longitude'],
                'previous_date' => $reschedule['previous_date'],
                'previous_time' => $reschedule['previous_time'],
                'proposed_location' => $reschedule['proposed_location'],
                'proposed_latitude' => $reschedule['proposed_latitude'] === null
                    ? null : (float) $reschedule['proposed_latitude'],
                'proposed_longitude' => $reschedule['proposed_longitude'] === null
                    ? null : (float) $reschedule['proposed_longitude'],
                'proposed_date' => $reschedule['proposed_date'],
                'proposed_time' => $reschedule['proposed_time'],
                'reason' => $reschedule['reason'],
                'status' => (string) $reschedule['status'],
                'response_note' => $reschedule['response_note'],
                'responded_at' => $reschedule['responded_at'],
                'created_at' => $reschedule['created_at']
            ];
        }
    }

    sendRecoveryListResponse(200, [
        'success' => true,
        'message' => 'Lost Pet recovery submissions retrieved successfully.',
        'scope' => $scope,
        'total' => $total,
        'count' => count($recoveries),
        'limit' => $limit,
        'offset' => $offset,
        'has_more' => $offset + count($recoveries) < $total,
        'recoveries' => array_values($recoveries)
    ]);
} catch (Throwable $e) {
    error_log('[PawRescue Get Lost Pet Recoveries] ' . $e->getMessage());
    sendRecoveryListResponse(500, [
        'success' => false,
        'message' => 'Unable to retrieve Lost Pet recovery submissions.'
    ]);
}
