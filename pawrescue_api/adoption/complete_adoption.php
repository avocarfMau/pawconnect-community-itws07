<?php
// =====================================
// PAWRESCUE COMMUNITY - CONFIRM ADOPTION HANDOVER
// =====================================
// CORS / OPTIONS handling remains in the existing server configuration.
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function reply(int $code, array $body): void
{
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// =====================================
// BEST-EFFORT FIREBASE NOTICE TO THE APPROVED ADOPTER
// =====================================
// This helper must be called only AFTER the adoption transaction commits.
// The recipient ID comes from the approved request stored in MySQL, not
// from the owner/browser's request body.
function notifyCompletedAdoption(
    PDO $conn,
    int $adopterId,
    int $requestId,
    int $adoptionId
): void {
    if ($adopterId <= 0 || $requestId <= 0 || $adoptionId <= 0) {
        return;
    }

    try {
        // Match the existing adoption notification implementation:
        // notify the intended resident's most recently active Android device.
        // Signing in through Chrome does not require a browser FCM token.
        $tokenStmt = $conn->prepare(
            "SELECT id, device_token
             FROM user_push_tokens
             WHERE user_id = :adopter_id
               AND platform = 'android'
               AND is_active = 1
             ORDER BY last_seen_at DESC, id DESC
             LIMIT 1"
        );
        $tokenStmt->execute([':adopter_id' => $adopterId]);
        $device = $tokenStmt->fetch(PDO::FETCH_ASSOC);

        if (
            !is_array($device) ||
            !is_string($device['device_token'] ?? null) ||
            $device['device_token'] === ''
        ) {
            return;
        }

        require_once __DIR__ . '/../push_notifications/fcm_sender.php';

        $pushResult = pawrescueSendFcmToToken(
            $device['device_token'],
            'Pet Adoption Completed',
            'The pet owner confirmed the handover. Your adoption is now complete. Open PawRescue to view it.',
            [
                'type' => 'adoption_completed',
                'request_id' => (string) $requestId,
                'adoption_id' => (string) $adoptionId,
                'status' => 'completed'
            ]
        );

        if (($pushResult['unregistered'] ?? false) === true) {
            // Never deactivate a token that was reassigned to another user.
            $disableStmt = $conn->prepare(
                "UPDATE user_push_tokens
                 SET is_active = 0, updated_at = NOW()
                 WHERE id = :token_id
                   AND user_id = :adopter_id
                   AND device_token = :device_token
                   AND platform = 'android'
                   AND is_active = 1"
            );
            $disableStmt->execute([
                ':token_id' => (int) $device['id'],
                ':adopter_id' => $adopterId,
                ':device_token' => $device['device_token']
            ]);
        }

        if (($pushResult['success'] ?? false) !== true) {
            // Never log authentication tokens, device tokens or private details.
            error_log('[PawRescue Adoption Completion Push] Firebase did not accept the notification.');
        }
    } catch (Throwable $pushError) {
        // Failure to send an FCM notification must not reverse a handover.
        error_log(
            '[PawRescue Adoption Completion Push] Notification unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    reply(405, ['success' => false, 'message' => 'Method not allowed.']);
}
if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') === false) {
    reply(415, ['success' => false, 'message' => 'Content-Type must be application/json.']);
}
require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
try {
    // =====================================
    // AUTHENTICATE PET OWNER
    // =====================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $ownerId = (int) $auth['user']['id'];

    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data) || array_is_list($data)) {
        reply(400, ['success' => false, 'message' => 'Invalid JSON request.']);
    }

    $adoptionId = filter_var($data['adoption_id'] ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1]
    ]);
    if ($adoptionId === false || $adoptionId === null) {
        reply(400, ['success' => false, 'message' => 'Invalid adoption post ID.']);
    }

    // =====================================
    // COMPLETE ONLY A RESERVED ADOPTION
    // =====================================
    $conn->beginTransaction();
    $postStmt = $conn->prepare(
        'SELECT id, status FROM pet_adoption_posts
         WHERE id = :adoption_id AND user_id = :user_id LIMIT 1 FOR UPDATE'
    );
    $postStmt->execute([':adoption_id' => $adoptionId, ':user_id' => $ownerId]);
    $post = $postStmt->fetch(PDO::FETCH_ASSOC);
    if (!$post) {
        $conn->rollBack();
        reply(404, ['success' => false, 'message' => 'Adoption post not found or access denied.']);
    }
    if ($post['status'] !== 'reserved') {
        $conn->rollBack();
        reply(409, ['success' => false, 'message' => 'Only reserved pets can be marked adopted.']);
    }

    // Read the approved applicant's identity BEFORE changing the status.
    // The pet owner initiates the completion, but the adopter receives
    // the Firebase notification afterward.
    $approvedStmt = $conn->prepare(
        "SELECT id, requester_id FROM pet_adoption_requests
         WHERE adoption_id = :adoption_id AND status = 'approved'
         LIMIT 1 FOR UPDATE"
    );
    $approvedStmt->execute([':adoption_id' => $adoptionId]);
    $approvedRequest = $approvedStmt->fetch(PDO::FETCH_ASSOC);
    if (!$approvedRequest || (int) $approvedRequest['requester_id'] <= 0) {
        $conn->rollBack();
        reply(409, ['success' => false, 'message' => 'No approved adoption request was found.']);
    }

    $approvedRequestId = (int) $approvedRequest['id'];
    $adopterId = (int) $approvedRequest['requester_id'];

    // Keep the adopter and listing updates in the SAME transaction.
    $completeRequest = $conn->prepare(
        "UPDATE pet_adoption_requests
         SET status = 'completed'
         WHERE id = :request_id AND status = 'approved'"
    );
    $completeRequest->execute([':request_id' => $approvedRequestId]);
    if ($completeRequest->rowCount() !== 1) {
        throw new RuntimeException('Approved adoption request changed before completion.');
    }

    $completePost = $conn->prepare(
        "UPDATE pet_adoption_posts
         SET status = 'adopted', adopted_at = NOW()
         WHERE id = :adoption_id AND status = 'reserved'"
    );
    $completePost->execute([':adoption_id' => $adoptionId]);
    if ($completePost->rowCount() !== 1) {
        throw new RuntimeException('Reserved adoption listing changed before completion.');
    }

    $conn->commit();

    // =====================================
    // NOTIFY THE APPROVED ADOPTER AFTER SUCCESSFUL COMMIT
    // =====================================
    // A repeated completion cannot send a duplicate notification,
    // because the listing is no longer 'reserved'.
    notifyCompletedAdoption($conn, $adopterId, $approvedRequestId, (int) $adoptionId);

    // Preserve the original success response used by the Ionic app.
    reply(200, [
        'success' => true,
        'message' => 'Adoption completed successfully.',
        'adoption_id' => (int) $adoptionId,
        'request_id' => $approvedRequestId,
        'status' => 'adopted'
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Adoption Complete] ' . $e->getMessage());
    reply(500, ['success' => false, 'message' => 'Unable to complete adoption.']);
}
