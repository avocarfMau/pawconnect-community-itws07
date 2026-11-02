<?php
// =====================================
// PAWRESCUE COMMUNITY - REQUEST ADOPTION
// =====================================
// CORS is handled by the existing .htaccess / cors.php.
// Only AVAILABLE pets can receive new adoption requests.

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function reply(int $code, array $body): void
{
    http_response_code($code);
    echo json_encode($body);
    exit;
}

// =====================================
// REQUEST VALIDATION
// =====================================

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    reply(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === false) {
    reply(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;

try {
    // =====================================
    // AUTHENTICATION - RESIDENT ONLY
    // =====================================

    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $requesterId = (int) $auth['user']['id'];

    $data = json_decode(file_get_contents('php://input'), true);

    if (!is_array($data) || array_is_list($data)) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid JSON request.'
        ]);
    }

    $adoptionId = filter_var(
        $data['adoption_id'] ?? null,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );

    $message = $data['message'] ?? null;

    if (
        $adoptionId === false ||
        $adoptionId === null ||
        !is_string($message) ||
        mb_strlen(trim($message)) < 10 ||
        mb_strlen(trim($message)) > 2000
    ) {
        reply(400, [
            'success' => false,
            'message' => 'Select an adoption post and write a message of 10–2000 characters.'
        ]);
    }

    $message = trim($message);

    // =====================================
    // VERIFY LISTING AND LOCK ITS STATUS
    // =====================================
    // Locking the post prevents concurrent request approval/status
    // changes from passing this availability check unnoticed.

    $conn->beginTransaction();

    $stmt = $conn->prepare(
        'SELECT user_id, status
         FROM pet_adoption_posts
         WHERE id = :adoption_id
         LIMIT 1 FOR UPDATE'
    );

    $stmt->execute([':adoption_id' => $adoptionId]);
    $post = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$post) {
        $conn->rollBack();
        reply(404, [
            'success' => false,
            'message' => 'Adoption listing not found.'
        ]);
    }

    if ((int) $post['user_id'] === $requesterId) {
        $conn->rollBack();
        reply(403, [
            'success' => false,
            'message' => 'You cannot adopt your own posted pet.'
        ]);
    }

    // Status must be checked again on the SERVER, even if the
    // mobile app still displays an older AVAILABLE state.
    $currentStatus = (string) $post['status'];

    if ($currentStatus !== 'available') {
        $conn->rollBack();

        switch ($currentStatus) {
            case 'reserved':
                $statusMessage = 'This pet is currently reserved. New adoption requests are not accepted.';
                break;
            case 'adopted':
                $statusMessage = 'This pet has already been adopted. New adoption requests are not accepted.';
                break;
            case 'closed':
                $statusMessage = 'This adoption listing is closed. New adoption requests are not accepted.';
                break;
            default:
                $statusMessage = 'This pet is no longer available for adoption requests.';
                break;
        }

        reply(409, [
            'success' => false,
            'message' => $statusMessage
        ]);
    }

    // =====================================
    // BLOCK DUPLICATE REQUESTS
    // =====================================

    $exists = $conn->prepare(
        'SELECT id
         FROM pet_adoption_requests
         WHERE adoption_id = :adoption_id
           AND requester_id = :requester_id
         LIMIT 1'
    );

    $exists->execute([
        ':adoption_id' => $adoptionId,
        ':requester_id' => $requesterId
    ]);

    if ($exists->fetchColumn()) {
        $conn->rollBack();
        reply(409, [
            'success' => false,
            'message' => 'You already requested to adopt this pet.'
        ]);
    }

    // =====================================
    // CREATE PENDING REQUEST
    // =====================================

    $insert = $conn->prepare(
        "INSERT INTO pet_adoption_requests
         (adoption_id, requester_id, message, status)
         VALUES (:adoption_id, :requester_id, :message, 'pending')"
    );

    $insert->execute([
        ':adoption_id' => $adoptionId,
        ':requester_id' => $requesterId,
        ':message' => $message
    ]);

    $requestId = (int) $conn->lastInsertId();
    $conn->commit();

    // =====================================
    // NOTIFY THE PET OWNER - ANDROID FCM
    // =====================================
    // The adoption request is already committed. Push delivery is
    // best-effort and must never change a successful submission to 500.
    // Recipient identity comes from the locked adoption post, not
    // from any user ID supplied by the requester/browser.
    try {
        $ownerId = (int) $post['user_id'];

        // Registering a browser session does not create an FCM token.
        // Only the owner's active Android installation can receive push.
        $tokenStmt = $conn->prepare(
            "SELECT id, device_token
             FROM user_push_tokens
             WHERE user_id = :owner_id
               AND platform = 'android'
               AND is_active = 1
             ORDER BY last_seen_at DESC, id DESC
             LIMIT 1"
        );
        $tokenStmt->execute([':owner_id' => $ownerId]);
        $ownerDevice = $tokenStmt->fetch(PDO::FETCH_ASSOC);

        if (
            is_array($ownerDevice) &&
            is_string($ownerDevice['device_token'] ?? null) &&
            $ownerDevice['device_token'] !== ''
        ) {
            require_once __DIR__ . '/../push_notifications/fcm_sender.php';

            $pushResult = pawrescueSendFcmToToken(
                $ownerDevice['device_token'],
                'New Adoption Request',
                'Someone submitted an adoption request for your pet. Open PawRescue to review it.',
                [
                    'type' => 'adoption_request_received',
                    'request_id' => (string) $requestId,
                    'adoption_id' => (string) $adoptionId
                ]
            );

            if (($pushResult['unregistered'] ?? false) === true) {
                // Remove only this invalid token registration. A token
                // reassigned to another resident must not be disabled.
                $disableStmt = $conn->prepare(
                    "UPDATE user_push_tokens
                     SET is_active = 0, updated_at = NOW()
                     WHERE id = :token_id
                       AND user_id = :owner_id
                       AND device_token = :device_token
                       AND platform = 'android'
                       AND is_active = 1"
                );
                $disableStmt->execute([
                    ':token_id' => (int) $ownerDevice['id'],
                    ':owner_id' => $ownerId,
                    ':device_token' => $ownerDevice['device_token']
                ]);
            }

            if (($pushResult['success'] ?? false) !== true) {
                // Never log the FCM token, bearer token or request message.
                error_log('[PawRescue Adoption Request Push] Firebase did not accept the notification.');
            }
        }
    } catch (Throwable $pushError) {
        // A push failure must not roll back a saved adoption request.
        error_log(
            '[PawRescue Adoption Request Push] Notification unavailable (' .
            get_class($pushError) . ').'
        );
    }

    reply(201, [
        'success' => true,
        'message' => 'Adoption request submitted successfully.',
        'request_id' => $requestId,
        'status' => 'pending'
    ]);

} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    error_log('[PawRescue Adoption Submit Request] ' . $e->getMessage());

    reply(500, [
        'success' => false,
        'message' => 'Unable to submit adoption request.'
    ]);
}
