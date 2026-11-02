<?php
// ============================================================
// PAWRESCUE COMMUNITY — CONFIRM LOST PET RECOVERY PICKUP
// STEP 56
// File: pawrescue_api/lost_pet_recoveries/confirm_recovery_pickup.php
// ============================================================
// Resident B (finder) confirms the PRIVATE pickup arrangement
// proposed by Resident A (Lost Pet owner) when approving a
// recovery submission.
//
// POST /pawrescue/pawrescue_api/lost_pet_recoveries/confirm_recovery_pickup.php
// Authorization: Bearer <resident_token>
// Content-Type: application/json
//
// { "recovery_id": 12 }
//
// This confirms ONLY the pickup schedule. It does NOT confirm
// physical handover, complete the recovery, or resolve any
// Lost/Found Pet report. Both parties must separately confirm
// the actual handover in a later step.
//
// CORS and OPTIONS handling use the existing backend config.
// ============================================================

declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

function sendRecoveryPickupResponse(int $httpStatus, array $body): void
{
    http_response_code($httpStatus);
    echo json_encode(
        $body,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function denyRecoveryPickup(PDO $conn, int $httpStatus, string $message, array $extra = []): void
{
    if ($conn->inTransaction()) {
        $conn->rollBack();
    }
    sendRecoveryPickupResponse($httpStatus, array_merge([
        'success' => false,
        'message' => $message
    ], $extra));
}

// ============================================================
// 1. VALIDATE POST REQUEST AND JSON PAYLOAD
// ============================================================
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST, OPTIONS');
    sendRecoveryPickupResponse(405, [
        'success' => false,
        'message' => 'Method not allowed.'
    ]);
}

if (!preg_match(
    '~^application/json(?:\s*;|\s*$)~i',
    trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''))
)) {
    sendRecoveryPickupResponse(415, [
        'success' => false,
        'message' => 'Content-Type must be application/json.'
    ]);
}

// There are no images in this endpoint; accept only a small body.
$rawBody = file_get_contents('php://input', false, null, 0, 4097);
if ($rawBody === false || strlen($rawBody) > 4096) {
    sendRecoveryPickupResponse(413, [
        'success' => false,
        'message' => 'Request is too large.'
    ]);
}

$payload = json_decode($rawBody, true);
if (
    json_last_error() !== JSON_ERROR_NONE ||
    !is_array($payload) ||
    array_is_list($payload)
) {
    sendRecoveryPickupResponse(400, [
        'success' => false,
        'message' => 'Invalid JSON request.'
    ]);
}

$recoveryId = filter_var(
    $payload['recovery_id'] ?? null,
    FILTER_VALIDATE_INT,
    ['options' => ['min_range' => 1]]
);

if ($recoveryId === false || $recoveryId === null) {
    sendRecoveryPickupResponse(400, [
        'success' => false,
        'message' => 'A valid recovery ID is required.'
    ]);
}

require_once __DIR__ . '/../middleware/auth_middleware.php';

$conn = null;
try {
    // ========================================================
    // 2. AUTHENTICATE THE FINDER (RESIDENT B)
    // ========================================================
    $auth = authenticate(['resident']);
    $conn = $auth['connection'] ?? null;
    $finderId = (int) ($auth['user']['id'] ?? 0);

    if (!($conn instanceof PDO) || $finderId <= 0) {
        throw new RuntimeException('Invalid authenticated resident session.');
    }

    // Read the parent ID solely to determine row-lock order.
    // Authorization is checked inside the transaction.
    $reportLookup = $conn->prepare(
        'SELECT lost_report_id
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id
         LIMIT 1'
    );
    $reportLookup->execute([':recovery_id' => $recoveryId]);
    $lostReportId = $reportLookup->fetchColumn();

    if ($lostReportId === false) {
        sendRecoveryPickupResponse(404, [
            'success' => false,
            'message' => 'Recovery submission not found.'
        ]);
    }

    $conn->beginTransaction();

    // All recovery mutations lock LOST report -> recovery row.
    $reportStmt = $conn->prepare(
        'SELECT id, user_id, report_type, status
         FROM pet_reports
         WHERE id = :lost_report_id
         LIMIT 1 FOR UPDATE'
    );
    $reportStmt->execute([':lost_report_id' => $lostReportId]);
    $report = $reportStmt->fetch(PDO::FETCH_ASSOC);

    if (!$report || $report['report_type'] !== 'lost') {
        denyRecoveryPickup($conn, 404, 'Recovery submission not found.');
    }

    $recoveryStmt = $conn->prepare(
        'SELECT id, lost_report_id, finder_user_id, status,
                pickup_location, pickup_latitude, pickup_longitude,
                pickup_date, pickup_time, pickup_timezone,
                pickup_confirmed_by_finder_at,
                owner_handover_confirmed_at, finder_handover_confirmed_at
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id AND lost_report_id = :lost_report_id
         LIMIT 1 FOR UPDATE'
    );
    $recoveryStmt->execute([
        ':recovery_id' => $recoveryId,
        ':lost_report_id' => $lostReportId
    ]);
    $recovery = $recoveryStmt->fetch(PDO::FETCH_ASSOC);

    // A 404 prevents another resident from discovering recovery
    // records, private locations, or the identity of the finder.
    if (
        !$recovery ||
        (int) $recovery['finder_user_id'] !== $finderId ||
        (int) $report['user_id'] === $finderId
    ) {
        denyRecoveryPickup($conn, 404, 'Recovery submission not found.');
    }

    if (!in_array(
        (string) $report['status'],
        ['pending', 'under_review', 'in_progress'],
        true
    )) {
        denyRecoveryPickup($conn, 409, 'This Lost Pet report is no longer active.');
    }

    // Only the owner-approved pickup may be confirmed. If a
    // reschedule is pending, the parties must decide it first.
    if ($recovery['status'] !== 'pickup_scheduled') {
        denyRecoveryPickup($conn, 409,
            $recovery['status'] === 'reschedule_requested'
                ? 'A reschedule request is pending. Confirm pickup after it is settled.'
                : 'This recovery does not have an approved pickup arrangement.',
            ['status' => (string) $recovery['status']]
        );
    }

    if (
        trim((string) $recovery['pickup_location']) === '' ||
        !$recovery['pickup_date'] ||
        !$recovery['pickup_time']
    ) {
        denyRecoveryPickup($conn, 409,
            'Pickup details are incomplete. Ask the Lost Pet owner to update the arrangement.'
        );
    }

    // Check the reschedule table too: do not rely on the status
    // alone to prevent accepting a superseded pickup time.
    $rescheduleStmt = $conn->prepare(
        "SELECT id FROM pet_lost_recovery_reschedules
         WHERE recovery_id = :recovery_id AND status = 'pending'
         LIMIT 1"
    );
    $rescheduleStmt->execute([':recovery_id' => $recoveryId]);
    if ($rescheduleStmt->fetchColumn() !== false) {
        denyRecoveryPickup($conn, 409,
            'A pickup reschedule is pending. Resolve it before confirming.'
        );
    }

    // An already-confirmed arrangement is safe to retry. Do not
    // change its original confirmation timestamp.
    if ($recovery['pickup_confirmed_by_finder_at'] !== null) {
        $conn->commit();
        sendRecoveryPickupResponse(200, [
            'success' => true,
            'message' => 'You have already confirmed this pickup arrangement.',
            'recovery_id' => $recoveryId,
            'lost_report_id' => (int) $lostReportId,
            'status' => 'pickup_scheduled',
            'already_confirmed' => true,
            'pickup' => [
                'location' => (string) $recovery['pickup_location'],
                'latitude' => $recovery['pickup_latitude'] === null
                    ? null : (float) $recovery['pickup_latitude'],
                'longitude' => $recovery['pickup_longitude'] === null
                    ? null : (float) $recovery['pickup_longitude'],
                'date' => (string) $recovery['pickup_date'],
                'time' => (string) $recovery['pickup_time'],
                'timezone' => (string) $recovery['pickup_timezone'],
                'finder_confirmed_at' => (string) $recovery['pickup_confirmed_by_finder_at']
            ]
        ]);
    }

    // A new pickup confirmation is not valid once a physical
    // handover confirmation has already started.
    if (
        $recovery['owner_handover_confirmed_at'] !== null ||
        $recovery['finder_handover_confirmed_at'] !== null
    ) {
        denyRecoveryPickup($conn, 409,
            'Handover confirmation has already started. This pickup cannot be newly confirmed.'
        );
    }

    // Approvals use Asia/Manila local date/time. Expired pickup
    // proposals must be rescheduled instead of newly accepted.
    $timezoneName = (string) ($recovery['pickup_timezone'] ?: 'Asia/Manila');
    if ($timezoneName !== 'Asia/Manila') {
        denyRecoveryPickup($conn, 409, 'Unsupported pickup timezone.');
    }

    $dateText = (string) $recovery['pickup_date'];
    $timeText = (string) $recovery['pickup_time'];
    $manila = new DateTimeZone('Asia/Manila');
    $pickupAt = DateTimeImmutable::createFromFormat(
        '!Y-m-d H:i:s',
        $dateText . ' ' . $timeText,
        $manila
    );
    if (
        !$pickupAt ||
        $pickupAt->format('Y-m-d H:i:s') !== $dateText . ' ' . $timeText ||
        $pickupAt <= new DateTimeImmutable('now', $manila)
    ) {
        denyRecoveryPickup($conn, 409,
            'The proposed pickup time has passed. Please request a new pickup schedule.'
        );
    }

    // ========================================================
    // 3. CONFIRM THE PICKUP — DO NOT COMPLETE THE RECOVERY
    // ========================================================
    $updateStmt = $conn->prepare(
        "UPDATE pet_lost_recovery_reports
         SET pickup_confirmed_by_finder_at = NOW()
         WHERE id = :recovery_id
           AND finder_user_id = :finder_id
           AND status = 'pickup_scheduled'
           AND pickup_confirmed_by_finder_at IS NULL"
    );
    $updateStmt->execute([
        ':recovery_id' => $recoveryId,
        ':finder_id' => $finderId
    ]);

    if ($updateStmt->rowCount() !== 1) {
        throw new RuntimeException('Pickup confirmation changed during update.');
    }

    $confirmedStmt = $conn->prepare(
        'SELECT pickup_confirmed_by_finder_at
         FROM pet_lost_recovery_reports
         WHERE id = :recovery_id'
    );
    $confirmedStmt->execute([':recovery_id' => $recoveryId]);
    $confirmedAt = $confirmedStmt->fetchColumn();

    $conn->commit();

    sendRecoveryPickupResponse(200, [
        'success' => true,
        'message' => 'Pickup arrangement confirmed. Meet the Lost Pet owner at the agreed location and time.',
        'recovery_id' => $recoveryId,
        'lost_report_id' => (int) $lostReportId,
        'status' => 'pickup_scheduled',
        'already_confirmed' => false,
        'pickup' => [
            'location' => (string) $recovery['pickup_location'],
            'latitude' => $recovery['pickup_latitude'] === null
                ? null : (float) $recovery['pickup_latitude'],
            'longitude' => $recovery['pickup_longitude'] === null
                ? null : (float) $recovery['pickup_longitude'],
            'date' => $dateText,
            'time' => $timeText,
            'timezone' => $timezoneName,
            'finder_confirmed_at' => $confirmedAt === false ? null : (string) $confirmedAt
        ]
    ]);
} catch (Throwable $e) {
    if ($conn instanceof PDO && $conn->inTransaction()) {
        $conn->rollBack();
    }
    error_log('[PawRescue Confirm Lost Pet Recovery Pickup] ' . $e->getMessage());
    sendRecoveryPickupResponse(500, [
        'success' => false,
        'message' => 'Unable to confirm the recovery pickup. Please try again.'
    ]);
}
