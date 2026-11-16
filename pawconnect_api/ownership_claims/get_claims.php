<?php

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendOwnershipClaimsResponse(int $status, array $body): void
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
    sendOwnershipClaimsResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

// ============================================================
// VALIDATE SCOPE, FILTERS, AND PAGINATION
// ============================================================
$scope = $_GET['scope'] ?? 'sent';
if (!is_string($scope) || !in_array($scope, ['sent', 'received'], true)) {
    sendOwnershipClaimsResponse(400, [
        'success' => false,
        'message' => 'Scope must be sent or received.'
    ]);
}

function optionalPositiveId(string $key): ?int
{
    if (!array_key_exists($key, $_GET)) {
        return null;
    }

    $value = $_GET[$key];
    if (!is_string($value) || !preg_match('/^[1-9][0-9]*$/D', $value)) {
        sendOwnershipClaimsResponse(400, [
            'success' => false,
            'message' => 'Invalid ' . $key . '.'
        ]);
    }

    $id = filter_var($value, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1]
    ]);

    if ($id === false) {
        sendOwnershipClaimsResponse(400, [
            'success' => false,
            'message' => 'Invalid ' . $key . '.'
        ]);
    }

    return $id;
}

$foundReportId = optionalPositiveId('found_report_id');
$claimId = optionalPositiveId('claim_id');

$limit = 20;
if (array_key_exists('limit', $_GET)) {
    $requestedLimit = optionalPositiveId('limit');
    if ($requestedLimit === null || $requestedLimit > 50) {
        sendOwnershipClaimsResponse(400, [
            'success' => false,
            'message' => 'Limit must be between 1 and 50.'
        ]);
    }
    $limit = $requestedLimit;
}

$offset = 0;
if (array_key_exists('offset', $_GET)) {
    $rawOffset = $_GET['offset'];
    if (!is_string($rawOffset) || !preg_match('/^(0|[1-9][0-9]*)$/D', $rawOffset)) {
        sendOwnershipClaimsResponse(400, [
            'success' => false,
            'message' => 'Offset must be a non-negative integer.'
        ]);
    }
    $validatedOffset = filter_var($rawOffset, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 0]
    ]);
    if ($validatedOffset === false || $validatedOffset > 1000000) {
        sendOwnershipClaimsResponse(400, [
            'success' => false,
            'message' => 'Invalid offset.'
        ]);
    }
    $offset = $validatedOffset;
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // ========================================================
    // RESIDENT ONLY - ID COMES FROM THE VERIFIED BEARER TOKEN
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $viewerId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $viewerId <= 0) {
        throw new RuntimeException('Authenticated session data is incomplete.');
    }

    // The same ownership rule is enforced in EVERY query below.
    // A claimant can see only their sent claims. A finder can see
    // only claims linked to Found Pet reports they posted.
    $where = "p.report_type = 'found'";
    if ($scope === 'received') {
        $where .= ' AND p.user_id = :viewer_id';
    } else {
        $where .= ' AND c.claimant_user_id = :viewer_id';
    }

    $params = [':viewer_id' => $viewerId];

    if ($foundReportId !== null) {
        $where .= ' AND c.found_report_id = :found_report_id';
        $params[':found_report_id'] = $foundReportId;
    }

    if ($claimId !== null) {
        $where .= ' AND c.id = :claim_id';
        $params[':claim_id'] = $claimId;
    }

    $from = ' FROM pet_ownership_claims c
              INNER JOIN pet_reports p
                  ON p.id = c.found_report_id ';

    // ========================================================
    // COUNT ACCESSIBLE CLAIMS FOR PAGINATION
    // ========================================================
    $countStmt = $conn->prepare('SELECT COUNT(*)' . $from . ' WHERE ' . $where);
    foreach ($params as $param => $value) {
        $countStmt->bindValue($param, $value, PDO::PARAM_INT);
    }
    $countStmt->execute();
    $total = (int) $countStmt->fetchColumn();

    // Individual claim retrieval must not reveal inaccessible IDs.
    if ($claimId !== null && $total === 0) {
        sendOwnershipClaimsResponse(404, [
            'success' => false,
            'message' => 'Ownership claim not found.'
        ]);
    }

    // ========================================================
    // READ PRIVATE CLAIM DETAILS FOR AUTHORIZED PARTICIPANTS
    // ========================================================
    $sql = 'SELECT
                c.id,
                c.found_report_id,
                c.claimant_user_id,
                c.linked_lost_report_id,
                c.proof_description,
                c.status,
                c.rejection_reason,
                c.cancellation_reason,
                c.dispute_reason,
                c.pickup_location,
                c.pickup_latitude,
                c.pickup_longitude,
                c.pickup_date,
                c.pickup_time,
                c.pickup_timezone,
                c.approved_at,
                c.pickup_confirmed_by_claimant_at,
                c.finder_handover_confirmed_at,
                c.claimant_handover_confirmed_at,
                c.completed_at,
                c.rejected_at,
                c.cancelled_at,
                c.disputed_at,
                c.created_at,
                c.updated_at,
                p.user_id AS finder_user_id,
                p.pet_name,
                p.animal_type,
                p.status AS found_report_status,
                claimant.full_name AS claimant_name,
                finder.full_name AS finder_name
            ' . $from . '
              INNER JOIN users claimant
                  ON claimant.id = c.claimant_user_id
              INNER JOIN users finder
                  ON finder.id = p.user_id
            WHERE ' . $where . '
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT :limit OFFSET :offset';

    $stmt = $conn->prepare($sql);
    foreach ($params as $param => $value) {
        $stmt->bindValue($param, $value, PDO::PARAM_INT);
    }
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Never return photo_path: that is an internal private path.
    $claims = [];
    $claimIds = [];

    foreach ($rows as $row) {
        $id = (int) $row['id'];
        $claimIds[] = $id;

        $claims[$id] = [
            'id' => $id,
            'found_report_id' => (int) $row['found_report_id'],
            'found_report_status' => (string) $row['found_report_status'],
            'pet_name' => $row['pet_name'],
            'animal_type' => (string) $row['animal_type'],
            'finder_user_id' => (int) $row['finder_user_id'],
            'finder_name' => (string) $row['finder_name'],
            'claimant_user_id' => (int) $row['claimant_user_id'],
            'claimant_name' => (string) $row['claimant_name'],
            'linked_lost_report_id' => $row['linked_lost_report_id'] === null
                ? null : (int) $row['linked_lost_report_id'],
            'proof_description' => (string) $row['proof_description'],
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
                'claimant_confirmed_at' => $row['pickup_confirmed_by_claimant_at']
            ],
            'approved_at' => $row['approved_at'],
            'finder_handover_confirmed_at' => $row['finder_handover_confirmed_at'],
            'claimant_handover_confirmed_at' => $row['claimant_handover_confirmed_at'],
            'completed_at' => $row['completed_at'],
            'rejected_at' => $row['rejected_at'],
            'cancelled_at' => $row['cancelled_at'],
            'disputed_at' => $row['disputed_at'],
            'created_at' => $row['created_at'],
            'updated_at' => $row['updated_at'],
            // This list contains metadata/IDs, NOT public image links.
            'evidence_photos' => [],
            'latest_reschedule' => null
        ];
    }

    // ========================================================
    // BATCH LOAD EVIDENCE PHOTO IDS (NO INTERNAL FILE PATHS)
    // ========================================================
    if ($claimIds !== []) {
        $placeholders = [];
        $values = [];
        foreach ($claimIds as $index => $id) {
            $key = ':evidence_claim_' . $index;
            $placeholders[] = $key;
            $values[$key] = $id;
        }

        $photoSql = 'SELECT id, claim_id, sort_order, created_at
                     FROM pet_ownership_claim_photos
                     WHERE claim_id IN (' . implode(', ', $placeholders) . ')
                     ORDER BY claim_id, sort_order, id';

        $photoStmt = $conn->prepare($photoSql);
        foreach ($values as $key => $id) {
            $photoStmt->bindValue($key, $id, PDO::PARAM_INT);
        }
        $photoStmt->execute();

        while ($photo = $photoStmt->fetch(PDO::FETCH_ASSOC)) {
            $parentId = (int) $photo['claim_id'];
            if (isset($claims[$parentId])) {
                $claims[$parentId]['evidence_photos'][] = [
                    'id' => (int) $photo['id'],
                    'sort_order' => (int) $photo['sort_order'],
                    'created_at' => $photo['created_at']
                ];
            }
        }

        // ====================================================
        // BATCH LOAD LATEST RESCHEDULE PER CLAIM
        // ====================================================
        // A full reschedule history endpoint can be added when
        // the schedule management UI is implemented. This latest
        // record tells each resident whether action is pending.
        $rescheduleSql = 'SELECT
                            r.id,
                            r.claim_id,
                            r.requested_by_user_id,
                            r.previous_location,
                            r.previous_latitude,
                            r.previous_longitude,
                            r.previous_date,
                            r.previous_time,
                            r.proposed_location,
                            r.proposed_latitude,
                            r.proposed_longitude,
                            r.proposed_date,
                            r.proposed_time,
                            r.reason,
                            r.status,
                            r.response_note,
                            r.responded_at,
                            r.created_at
                          FROM pet_ownership_pickup_reschedules r
                          WHERE r.claim_id IN (' . implode(', ', $placeholders) . ')
                            AND r.id = (
                                SELECT newest.id
                                FROM pet_ownership_pickup_reschedules newest
                                WHERE newest.claim_id = r.claim_id
                                ORDER BY newest.created_at DESC, newest.id DESC
                                LIMIT 1
                            )';

        $rescheduleStmt = $conn->prepare($rescheduleSql);
        foreach ($values as $key => $id) {
            $rescheduleStmt->bindValue($key, $id, PDO::PARAM_INT);
        }
        $rescheduleStmt->execute();

        while ($reschedule = $rescheduleStmt->fetch(PDO::FETCH_ASSOC)) {
            $parentId = (int) $reschedule['claim_id'];
            if (!isset($claims[$parentId]) || $claims[$parentId]['latest_reschedule'] !== null) {
                continue;
            }
            $claims[$parentId]['latest_reschedule'] = [
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

    sendOwnershipClaimsResponse(200, [
        'success' => true,
        'message' => 'Ownership claims retrieved successfully.',
        'scope' => $scope,
        'total' => $total,
        'count' => count($claims),
        'limit' => $limit,
        'offset' => $offset,
        'has_more' => $offset + count($claims) < $total,
        'claims' => array_values($claims)
    ]);

} catch (Throwable $e) {
    error_log('[PawRescue Get Ownership Claims] ' . $e->getMessage());
    sendOwnershipClaimsResponse(500, [
        'success' => false,
        'message' => 'Unable to retrieve ownership claims.'
    ]);
}
