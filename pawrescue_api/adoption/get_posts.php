<?php
// =====================================
// PAWRESCUE COMMUNITY - ADOPTION POSTS
// =====================================
// CORS is handled by the existing .htaccess / cors.php.
// Community feed shows available and reserved pets only.
// Adopted and closed posts are hidden from the community feed.
// Owners retain their full listing history through scope=mine.
// Preserves API fields, photo ordering, and query timing diagnostics.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

$requestStartedAt = microtime(true);

// =====================================
// JSON RESPONSE HELPER
// =====================================
function reply(int $code, array $body, array $timings = []): void
{
    http_response_code($code);

    // Preserve a valid JSON response if a database field unexpectedly
    // contains invalid UTF-8; avoid breaking the Angular JSON parser.
    $json = json_encode(
        $body,
        JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );

    if ($json === false) {
        http_response_code(500);
        $json = '{"success":false,"message":"Unable to prepare adoption response."}';
    }

    if ($timings !== []) {
        $parts = [];
        foreach ($timings as $name => $milliseconds) {
            $parts[] = $name . ';dur=' . number_format((float)$milliseconds, 1, '.', '');
        }
        header('Server-Timing: ' . implode(', ', $parts));
    }

    // Return ordinary JSON. Let the web server negotiate compression when
    // configured for it; manually gzipping here can complicate diagnosis
    // if the server also applies response compression.
    echo $json;
    exit;
}

// =====================================
// REQUEST METHOD VALIDATION
// =====================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET, OPTIONS');
    reply(405, ['success' => false, 'message' => 'Method not allowed.']);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

try {
    // =====================================
    // AUTHENTICATION
    // =====================================
    $auth = authenticate(['resident', 'staff']);
    $conn = $auth['connection'];
    $userId = (int)$auth['user']['id'];
    $role = (string)$auth['user']['role'];

    // =====================================
    // VALIDATE FILTERS
    // =====================================
    $scope = $_GET['scope'] ?? 'community';
    $type = $_GET['type'] ?? 'all';
    $status = $_GET['status'] ?? 'all';
    $postIdRaw = $_GET['id'] ?? null;

    if (
        !is_string($scope) || !in_array($scope, ['community', 'mine'], true) ||
        !is_string($type) || !in_array($type, ['all', 'dog', 'cat'], true) ||
        !is_string($status) ||
        !in_array($status, ['all', 'available', 'reserved', 'adopted', 'closed'], true)
    ) {
        reply(400, ['success' => false, 'message' => 'Invalid listing filters.']);
    }

    if ($scope === 'mine' && $role !== 'resident') {
        reply(403, ['success' => false, 'message' => 'Only residents have personal adoption posts.']);
    }

    $postId = null;
    if ($postIdRaw !== null) {
        $postId = filter_var(
            $postIdRaw,
            FILTER_VALIDATE_INT,
            ['options' => ['min_range' => 1]]
        );

        if ($postId === false) {
            reply(400, ['success' => false, 'message' => 'Invalid adoption post ID.']);
        }
    }

    // =====================================
    // FETCH POSTS (ONE QUERY)
    // =====================================
    // Keep all fields intact so Pet Adoption, My Adoptions, and
    // Adoption Details remain compatible with the current service.
    $sql = "SELECT p.id, p.user_id, p.pet_name, p.animal_type,
                   p.sex, p.age_months, p.breed, p.description,
                   p.health_notes, p.barangay, p.location_details,
                   p.status, p.adopted_at, p.created_at, p.updated_at,
                   u.full_name AS owner_name
            FROM pet_adoption_posts p
            INNER JOIN users u ON u.id = p.user_id
            WHERE 1 = 1";

    $params = [];

    if ($scope === 'mine') {
        $sql .= ' AND p.user_id = :user_id';
        $params[':user_id'] = $userId;
    } else {
        // The public feed shows only pets still open for adoption or
        // awaiting handover. After handover is confirmed, adopted pets
        // disappear from public listings but remain in the owner's history.
        // Reject explicit status filters that could bypass this rule.
        if ($status === 'all') {
            $sql .= " AND p.status IN ('available', 'reserved')";
        } elseif ($status === 'adopted' || $status === 'closed') {
            reply(400, [
                'success' => false,
                'message' => 'Adopted and closed listings are not shown in the community feed.'
            ]);
        } else {
            $sql .= ' AND p.status = :status';
            $params[':status'] = $status;
        }
    }

    if ($scope === 'mine' && $status !== 'all') {
        $sql .= ' AND p.status = :status';
        $params[':status'] = $status;
    }

    if ($type !== 'all') {
        $sql .= ' AND p.animal_type = :animal_type';
        $params[':animal_type'] = $type;
    }

    if ($postId !== null) {
        $sql .= ' AND p.id = :post_id';
        $params[':post_id'] = $postId;
    }

    // Preserve the existing 100-post feed limit and newest-first order.
    $sql .= ' ORDER BY p.created_at DESC, p.id DESC LIMIT 100';

    $postsQueryStartedAt = microtime(true);
    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    $posts = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $postsDurationMs = (microtime(true) - $postsQueryStartedAt) * 1000;

    // =====================================
    // FETCH ALL PHOTOS (ONE QUERY)
    // =====================================
    // Two total SQL queries avoid the expensive N+1 approach of
    // fetching photos separately for each adoption post.
    $photosDurationMs = 0.0;
    $photosByPost = [];

    if ($posts !== []) {
        $ids = array_map(static fn(array $post): int => (int)$post['id'], $posts);
        $placeholders = implode(',', array_fill(0, count($ids), '?'));

        $photosQueryStartedAt = microtime(true);
        $photosStmt = $conn->prepare(
            'SELECT id, adoption_id, photo_path, sort_order, created_at
             FROM pet_adoption_photos
             WHERE adoption_id IN (' . $placeholders . ')
             ORDER BY adoption_id, sort_order, id'
        );
        $photosStmt->execute($ids);

        while ($photo = $photosStmt->fetch(PDO::FETCH_ASSOC)) {
            $key = (int)$photo['adoption_id'];
            $photo['id'] = (int)$photo['id'];
            $photo['adoption_id'] = $key;
            $photo['sort_order'] = (int)$photo['sort_order'];
            $photosByPost[$key][] = $photo;
        }

        $photosDurationMs = (microtime(true) - $photosQueryStartedAt) * 1000;
    }

    // =====================================
    // NORMALIZE RESPONSE
    // =====================================
    foreach ($posts as &$post) {
        $id = (int)$post['id'];
        $post['id'] = $id;
        $post['user_id'] = (int)$post['user_id'];
        $post['age_months'] = $post['age_months'] !== null
            ? (int)$post['age_months']
            : null;
        $post['photos'] = $photosByPost[$id] ?? [];
        $post['photo_count'] = count($post['photos']);
        $post['photo_path'] = $post['photos'][0]['photo_path'] ?? null;
        $post['is_owner'] = ($post['user_id'] === $userId);
    }
    unset($post);

    // =====================================
    // DIAGNOSTICS (NON-BLOCKING)
    // =====================================
    $totalDurationMs = (microtime(true) - $requestStartedAt) * 1000;

    if ($totalDurationMs >= 2000) {
        error_log(sprintf(
            '[PawRescue Adoption Get Posts] Slow request: total=%.1fms posts=%.1fms photos=%.1fms count=%d scope=%s',
            $totalDurationMs,
            $postsDurationMs,
            $photosDurationMs,
            count($posts),
            $scope
        ));
    }

    reply(200, [
        'success' => true,
        'message' => 'Adoption posts retrieved successfully.',
        'count' => count($posts),
        'posts' => $posts
    ], [
        'posts' => $postsDurationMs,
        'photos' => $photosDurationMs,
        'total' => $totalDurationMs
    ]);
} catch (Throwable $e) {
    error_log('[PawRescue Adoption Get Posts] ' . $e->getMessage());
    reply(500, ['success' => false, 'message' => 'Unable to retrieve adoption posts.']);
}
