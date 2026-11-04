<?php
// =====================================
// PAWRESCUE COMMUNITY - APPROVE / REJECT / RESCHEDULE ADOPTION REQUEST
// WITH PICKUP ARRANGEMENTS
// =====================================
// CORS is handled by the existing .htaccess / cors.php.
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

function reply(int $code, array $body): void
{
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

// =====================================
// BEST-EFFORT FIREBASE NOTICE FOR ONE ADOPTION APPLICANT
// =====================================
// The recipient comes from saved adoption request records. Only call
// this function AFTER the database transaction has committed.
// Browser-only accounts need no FCM token to use the adoption workflow.
function notifyAdoptionApplicant(
    PDO $conn,
    int $recipientId,
    string $title,
    string $message,
    string $eventType,
    int $requestId,
    int $adoptionId,
    string $status
): void {
    if ($recipientId <= 0 || $requestId <= 0 || $adoptionId <= 0) {
        return;
    }

    try {
        // Choose only the most recently active Android device for
        // the intended resident, matching the existing submit_request.php.
        $tokenStmt = $conn->prepare(
            "SELECT id, device_token
             FROM user_push_tokens
             WHERE user_id = :recipient_id
               AND platform = 'android'
               AND is_active = 1
             ORDER BY last_seen_at DESC, id DESC
             LIMIT 1"
        );
        $tokenStmt->execute([':recipient_id' => $recipientId]);
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
            $title,
            $message,
            [
                'type' => $eventType,
                'request_id' => (string) $requestId,
                'adoption_id' => (string) $adoptionId,
                'status' => $status
            ]
        );

        if (($pushResult['unregistered'] ?? false) === true) {
            // Disable only this exact registration, never a token that
            // has since been reassigned to another resident.
            $disable = $conn->prepare(
                "UPDATE user_push_tokens
                 SET is_active = 0, updated_at = NOW()
                 WHERE id = :token_id
                   AND user_id = :recipient_id
                   AND device_token = :device_token
                   AND platform = 'android'
                   AND is_active = 1"
            );
            $disable->execute([
                ':token_id' => (int) $device['id'],
                ':recipient_id' => $recipientId,
                ':device_token' => $device['device_token']
            ]);
        }

        if (($pushResult['success'] ?? false) !== true) {
            // Never log tokens, personal adoption messages, or pickup data.
            error_log('[PawRescue Adoption Decision Push] Firebase did not accept a notification.');
        }
    } catch (Throwable $pushError) {
        // Notifications do not determine the result of the saved action.
        error_log(
            '[PawRescue Adoption Decision Push] Notification unavailable (' .
            get_class($pushError) . ').'
        );
    }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
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
    $auth = authenticate(['resident']);
    $conn = $auth['connection'];
    $ownerId = (int) $auth['user']['id'];

    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data) || array_is_list($data)) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid JSON request.'
        ]);
    }

    $requestId = filter_var(
        $data['request_id'] ?? null,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 1]]
    );
    $action = $data['action'] ?? null;

    if (
        $requestId === false ||
        $requestId === null ||
        !is_string($action) ||
        !in_array($action, ['approve', 'reject', 'reschedule'], true)
    ) {
        reply(400, [
            'success' => false,
            'message' => 'Invalid adoption request or action.'
        ]);
    }

    // Pickup information is required for approval and rescheduling.
    // The owner and approved applicant will later see these details
    // through the authenticated request-list endpoint.
    $meetingLocation = null;
    $pickupDate = null;
    $pickupTime = null;

    if ($action === 'approve' || $action === 'reschedule') {
        $rawLocation = $data['meeting_location'] ?? null;
        $rawDate = $data['pickup_date'] ?? null;
        $rawTime = $data['pickup_time'] ?? null;

        if (!is_string($rawLocation)) {
            reply(422, [
                'success' => false,
                'message' => 'Please enter the pet handover meeting location.'
            ]);
        }

        // A single-line location is easier to display and cannot contain
        // hidden control characters. Use byte length to match VARCHAR(255)
        // safely even when the location contains multibyte characters.
        $meetingLocation = trim($rawLocation);
        if (
            strlen($meetingLocation) < 5 ||
            strlen($meetingLocation) > 255 ||
            preg_match('/[\x00-\x1F\x7F]/', $meetingLocation)
        ) {
            reply(422, [
                'success' => false,
                'message' => 'Enter a valid single-line meeting location (5 to 255 bytes).'
            ]);
        }

        if (!is_string($rawDate) ||
            !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $rawDate)) {
            reply(422, [
                'success' => false,
                'message' => 'Select a valid pickup date (YYYY-MM-DD).'
            ]);
        }

        [$year, $month, $day] = array_map('intval', explode('-', $rawDate));
        if (!checkdate($month, $day, $year)) {
            reply(422, [
                'success' => false,
                'message' => 'The selected pickup date is invalid.'
            ]);
        }
        $pickupDate = $rawDate;

        // Normalize the input to a string before validation. This avoids
        // possibly-undefined regex match variables in PHP code editors.
        $timeInput = is_string($rawTime) ? $rawTime : '';
        if (!preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/D', $timeInput)) {
            reply(422, [
                'success' => false,
                'message' => 'Select a valid pickup time.'
            ]);
        }

        // HTML time inputs ordinarily send HH:MM. Store HH:MM:SS in MySQL.
        $pickupTime = strlen($timeInput) === 5
            ? $timeInput . ':00'
            : $timeInput;

        // Meeting dates and times are interpreted as Philippine local time.
        $philippineTime = new DateTimeZone('Asia/Manila');
        $pickupAt = new DateTimeImmutable(
            $pickupDate . ' ' . $pickupTime,
            $philippineTime
        );
        $now = new DateTimeImmutable('now', $philippineTime);

        if ($pickupAt <= $now) {
            reply(422, [
                'success' => false,
                'message' => 'Pickup date and time must be in the future (Philippine time).'
            ]);
        }
    }

    // An optional reason is stored in the private rescheduling history.
    // The existing approval and rejection requests do not need a reason.
    $rescheduleReason = null;
    if ($action === 'reschedule') {
        $reasonInput = $data['reason'] ?? null;
        if ($reasonInput !== null && !is_string($reasonInput)) {
            reply(422, [
                'success' => false,
                'message' => 'Enter a valid reason for rescheduling.'
            ]);
        }

        if (is_string($reasonInput)) {
            $reasonInput = trim($reasonInput);
            if (
                strlen($reasonInput) > 255 ||
                preg_match('/[\x00-\x1F\x7F]/', $reasonInput)
            ) {
                reply(422, [
                    'success' => false,
                    'message' => 'Reschedule reason must be a single line of up to 255 bytes.'
                ]);
            }
            $rescheduleReason = $reasonInput !== '' ? $reasonInput : null;
        }
    }

    // Find the related listing first. Lock the listing row before the
    // requested application, consistently with other adoption operations.
    $lookup = $conn->prepare(
        'SELECT adoption_id
         FROM pet_adoption_requests
         WHERE id = :request_id
         LIMIT 1'
    );
    $lookup->execute([':request_id' => $requestId]);
    $adoptionId = $lookup->fetchColumn();

    if ($adoptionId === false) {
        reply(404, [
            'success' => false,
            'message' => 'Adoption request not found.'
        ]);
    }
    $adoptionId = (int) $adoptionId;

    $conn->beginTransaction();

    $parentStmt = $conn->prepare(
        'SELECT id, user_id, status
         FROM pet_adoption_posts
         WHERE id = :adoption_id
         LIMIT 1 FOR UPDATE'
    );
    $parentStmt->execute([':adoption_id' => $adoptionId]);
    $post = $parentStmt->fetch(PDO::FETCH_ASSOC);

    if (!$post || (int) $post['user_id'] !== $ownerId) {
        $conn->rollBack();
        reply(404, [
            'success' => false,
            'message' => 'Adoption request not found or access denied.'
        ]);
    }

    $requestStmt = $conn->prepare(
        'SELECT id, requester_id, status, meeting_location, pickup_date, pickup_time
         FROM pet_adoption_requests
         WHERE id = :request_id AND adoption_id = :adoption_id
         LIMIT 1 FOR UPDATE'
    );
    $requestStmt->execute([
        ':request_id' => $requestId,
        ':adoption_id' => $adoptionId
    ]);
    $request = $requestStmt->fetch(PDO::FETCH_ASSOC);

    if (!$request) {
        $conn->rollBack();
        reply(404, [
            'success' => false,
            'message' => 'Adoption request not found.'
        ]);
    }

    if ($action === 'reschedule') {
        // Only the owner of a RESERVED listing can reschedule its
        // APPROVED application. Previously rejected applicants stay rejected.
        if ($request['status'] !== 'approved' || $post['status'] !== 'reserved') {
            $conn->rollBack();
            reply(409, [
                'success' => false,
                'message' => 'Only an approved adoption with a reserved pet can be rescheduled.'
            ]);
        }
    } else {
        // Preserve the pre-existing rules for approve and reject.
        if ($request['status'] !== 'pending') {
            $conn->rollBack();
            reply(409, [
                'success' => false,
                'message' => 'This adoption request has already been processed.'
            ]);
        }

        if ($post['status'] !== 'available') {
            $conn->rollBack();
            reply(409, [
                'success' => false,
                'message' => 'This pet is no longer available for approval or rejection.'
            ]);
        }
    }

    $otherRequestsRejected = 0;
    $otherApplicantsNotice = null;
    $listingStatus = 'available';
    $rescheduleId = null;
    $otherPendingApplicants = [];

    if ($action === 'approve') {
        // Save the pickup plan on the selected request ONLY.
        $approve = $conn->prepare(
            "UPDATE pet_adoption_requests
             SET status = 'approved',
                 meeting_location = :meeting_location,
                 pickup_date = :pickup_date,
                 pickup_time = :pickup_time
             WHERE id = :request_id AND status = 'pending'"
        );
        $approve->execute([
            ':meeting_location' => $meetingLocation,
            ':pickup_date' => $pickupDate,
            ':pickup_time' => $pickupTime,
            ':request_id' => $requestId
        ]);

        if ($approve->rowCount() !== 1) {
            throw new RuntimeException('Failed to approve the selected application.');
        }

        // Capture exactly the other PENDING applications before closing
        // them, so only affected residents receive a post-commit notice.
        // The locked parent listing serializes competing request changes.
        // Never include private pickup arrangements in their notification.
        $otherPendingStmt = $conn->prepare(
            "SELECT id, requester_id
             FROM pet_adoption_requests
             WHERE adoption_id = :adoption_id
               AND id <> :request_id
               AND status = 'pending'"
        );
        $otherPendingStmt->execute([
            ':adoption_id' => $adoptionId,
            ':request_id' => $requestId
        ]);
        $otherPendingApplicants = $otherPendingStmt->fetchAll(PDO::FETCH_ASSOC);

        // Other applicants do not receive the pickup information.
        $rejectOthers = $conn->prepare(
            "UPDATE pet_adoption_requests
             SET status = 'rejected'
             WHERE adoption_id = :adoption_id
               AND id <> :request_id
               AND status = 'pending'"
        );
        $rejectOthers->execute([
            ':adoption_id' => $adoptionId,
            ':request_id' => $requestId
        ]);
        $otherRequestsRejected = $rejectOthers->rowCount();

        // Reserve the listing so no further applications can be made.
        $reserve = $conn->prepare(
            "UPDATE pet_adoption_posts
             SET status = 'reserved'
             WHERE id = :adoption_id AND status = 'available'"
        );
        $reserve->execute([':adoption_id' => $adoptionId]);

        if ($reserve->rowCount() !== 1) {
            throw new RuntimeException('Failed to reserve the adoption listing.');
        }

        $newStatus = 'approved';
        $listingStatus = 'reserved';
        $otherApplicantsNotice =
            'Another applicant has already been approved to adopt this pet. '
            . 'Thank you for your interest.';
        $responseMessage =
            'Adoption request approved. Pickup arrangements saved. '
            . 'The pet is now reserved and other pending requests were rejected. '
            . 'Confirm the physical handover before marking the pet as adopted.';
    } elseif ($action === 'reschedule') {
        // Compare the NEW details to the current approved schedule.
        // Never generate a history record for an unchanged appointment.
        $previousLocation = $request['meeting_location'] !== null
            ? (string) $request['meeting_location'] : null;
        $previousDate = $request['pickup_date'] !== null
            ? (string) $request['pickup_date'] : null;
        $previousTime = $request['pickup_time'] !== null
            ? (string) $request['pickup_time'] : null;

        if (
            $previousLocation === $meetingLocation &&
            $previousDate === $pickupDate &&
            $previousTime === $pickupTime
        ) {
            $conn->rollBack();
            reply(422, [
                'success' => false,
                'message' => 'No changes detected. Enter a different pickup arrangement.'
            ]);
        }

        // Update the selected approved request; the listing remains reserved.
        $update = $conn->prepare(
            "UPDATE pet_adoption_requests
             SET meeting_location = :meeting_location,
                 pickup_date = :pickup_date,
                 pickup_time = :pickup_time
             WHERE id = :request_id AND status = 'approved'"
        );
        $update->execute([
            ':meeting_location' => $meetingLocation,
            ':pickup_date' => $pickupDate,
            ':pickup_time' => $pickupTime,
            ':request_id' => $requestId
        ]);

        if ($update->rowCount() !== 1) {
            throw new RuntimeException('Failed to update the approved pickup arrangement.');
        }

        // Save the old and new arrangements atomically with the update.
        // If history insertion fails, the reschedule is rolled back too.
        $history = $conn->prepare(
            'INSERT INTO pet_adoption_pickup_reschedules (
                adoption_request_id, changed_by_user_id,
                previous_meeting_location, previous_pickup_date,
                previous_pickup_time, new_meeting_location,
                new_pickup_date, new_pickup_time, reason
            ) VALUES (
                :request_id, :owner_id,
                :previous_location, :previous_date,
                :previous_time, :new_location,
                :new_date, :new_time, :reason
            )'
        );
        $history->execute([
            ':request_id' => $requestId,
            ':owner_id' => $ownerId,
            ':previous_location' => $previousLocation,
            ':previous_date' => $previousDate,
            ':previous_time' => $previousTime,
            ':new_location' => $meetingLocation,
            ':new_date' => $pickupDate,
            ':new_time' => $pickupTime,
            ':reason' => $rescheduleReason
        ]);

        $rescheduleId = (int) $conn->lastInsertId();
        $newStatus = 'approved';
        $listingStatus = 'reserved';
        $responseMessage =
            'Pickup arrangements updated successfully. The adoption remains approved '
            . 'and the pet remains reserved. The approved adopter can view the new '
            . 'schedule under My Adoptions.';
    } else {
        // Reject only the selected request. The listing stays available.
        $reject = $conn->prepare(
            "UPDATE pet_adoption_requests
             SET status = 'rejected'
             WHERE id = :request_id AND status = 'pending'"
        );
        $reject->execute([':request_id' => $requestId]);

        if ($reject->rowCount() !== 1) {
            throw new RuntimeException('Failed to reject the selected application.');
        }

        $newStatus = 'rejected';
        $responseMessage = 'Adoption request rejected. The pet remains available.';
    }

    $conn->commit();

    // =====================================
    // SEND NOTIFICATIONS ONLY AFTER A SUCCESSFUL COMMIT
    // =====================================
    // A Firebase failure must not undo a valid adoption decision.
    // The user IDs are taken from the verified, authorized DB records.
    $applicantId = (int) $request['requester_id'];

    if ($action === 'approve') {
        notifyAdoptionApplicant(
            $conn,
            $applicantId,
            'Adoption Request Approved',
            'Your adoption request was approved. Open PawRescue to review the pickup arrangement.',
            'adoption_request_approved',
            (int) $requestId,
            $adoptionId,
            'approved'
        );

        // These requests were automatically marked rejected because an
        // adopter was chosen, not because the owner evaluated them again.
        foreach ($otherPendingApplicants as $otherApplicant) {
            $otherRequestId = (int) ($otherApplicant['id'] ?? 0);
            $otherApplicantId = (int) ($otherApplicant['requester_id'] ?? 0);
            if ($otherRequestId <= 0 || $otherApplicantId <= 0) {
                continue;
            }
            notifyAdoptionApplicant(
                $conn,
                $otherApplicantId,
                'Adoption Request Closed',
                'Another applicant was approved to adopt this pet. Your request is no longer pending.',
                'adoption_request_closed',
                $otherRequestId,
                $adoptionId,
                'rejected'
            );
        }
    } elseif ($action === 'reschedule') {
        notifyAdoptionApplicant(
            $conn,
            $applicantId,
            'Adoption Pickup Rescheduled',
            'The pet owner updated your pickup arrangement. Open PawRescue to review the new schedule.',
            'adoption_pickup_rescheduled',
            (int) $requestId,
            $adoptionId,
            'approved'
        );
    } else {
        notifyAdoptionApplicant(
            $conn,
            $applicantId,
            'Adoption Request Update',
            'Your adoption request was not approved. Open PawRescue to view the result.',
            'adoption_request_rejected',
            (int) $requestId,
            $adoptionId,
            'rejected'
        );
    }

    // The response goes to the owner. The updated get_requests.php will
    // show the new schedule to the approved applicant on the next refresh.
    reply(200, [
        'success' => true,
        'message' => $responseMessage,
        'request_id' => $requestId,
        'adoption_id' => $adoptionId,
        'status' => $newStatus,
        'listing_status' => $listingStatus,
        'meeting_location' => $meetingLocation,
        'pickup_date' => $pickupDate,
        'pickup_time' => $pickupTime,
        'other_requests_rejected' => $otherRequestsRejected,
        'other_applicants_notice' => $otherApplicantsNotice,
        'reschedule_id' => $rescheduleId
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }

    error_log('[PawRescue Adoption Respond Request] ' . $e->getMessage());

    // Helpful diagnostics if a required migration was not applied.
    if ($e instanceof PDOException && $e->getCode() === '42S02') {
        reply(500, [
            'success' => false,
            'message' => 'Pickup reschedule history table is missing. Run the reschedule database update.'
        ]);
    }
    if ($e instanceof PDOException && $e->getCode() === '42S22') {
        reply(500, [
            'success' => false,
            'message' => 'Pickup scheduling database columns are missing. Run the Step 1 database update.'
        ]);
    }

    reply(500, [
        'success' => false,
        'message' => 'Unable to process adoption request.'
    ]);
}
