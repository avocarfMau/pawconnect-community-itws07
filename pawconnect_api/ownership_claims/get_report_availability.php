<?php


header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendClaimAvailabilityResponse(int $httpStatus, array $body): void
{
    http_response_code($httpStatus);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    sendClaimAvailabilityResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $residentId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $residentId <= 0) {
        throw new RuntimeException('Invalid authenticated session.');
    }

    // Only active Found Pet reports appear here. The status is
    // derived from claim records, never a client-supplied value.
    // No private evidence, applicant identity or pickup data is read.
    //
    // Priority is defensive: a completed claim means returned, an
    // unresolved dispute means blocked, otherwise an approved or
    // scheduled claim means reserved.
    //
    // A report can move between states after this GET returns.
    // submit_claim.php uses database locking to enforce the real rule.
    $sql = <<<'SQL'
SELECT
    p.id AS report_id,
    CASE
        WHEN MAX(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) = 1
            THEN 'returned'
        WHEN MAX(CASE WHEN c.status = 'disputed' THEN 1 ELSE 0 END) = 1
            THEN 'under_dispute'
        ELSE 'reserved'
    END AS availability
FROM pet_reports AS p
INNER JOIN pet_ownership_claims AS c
    ON c.found_report_id = p.id
WHERE p.report_type = 'found'
  AND p.status IN ('pending', 'under_review', 'in_progress')
  AND c.status IN (
      'approved',
      'pickup_scheduled',
      'reschedule_requested',
      'disputed',
      'completed'
  )
GROUP BY p.id
ORDER BY p.id DESC
SQL;

    $stmt = $conn->query($sql);
    $results = [];

    while ($record = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $results[] = [
            'report_id' => (int) $record['report_id'],
            'availability' => (string) $record['availability'],
            'can_claim' => false
        ];
    }

    sendClaimAvailabilityResponse(200, [
        'success' => true,
        'message' => 'Found Pet claim availability retrieved.',
        'count' => count($results),
        'report_availability' => $results
    ]);
} catch (Throwable $e) {
    error_log(
        '[PawRescue Found Pet Claim Availability] ' . $e->getMessage()
    );

    sendClaimAvailabilityResponse(500, [
        'success' => false,
        'message' => 'Unable to retrieve Found Pet claim availability.'
    ]);
}
