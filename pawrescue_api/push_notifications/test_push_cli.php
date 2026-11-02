<?php
/**
 * PawRescue Community — Step 6.3
 * File: pawrescue_api/push_notifications/test_push_cli.php
 *
 * Send ONE test push notification to the most recently active Android
 * device registered to a specified resident in user_push_tokens.
 *
 * COMMAND-LINE ONLY. Never invoke this script through a browser or API.
 * It does not print device tokens, passwords or Firebase credentials.
 *
 * Run from the PawRescue backend folder (XAMPP PHP):
 *   C:\xampp\php\php.exe push_notifications\test_push_cli.php 3 --send
 *
 * Replace 3 with the resident user_id to test. You must provide --send.
 * Requirements:
 *   - pawrescue_api/config/database.php with Database class (connect or
 *     getConnection), or an already initialized $conn/$pdo PDO connection.
 *   - pawrescue_api/push_notifications/fcm_sender.php from Step 6.2.
 *   - user_push_tokens table with an active Android FCM token.
 *   - private Firebase service-account.json outside htdocs.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

function testPushStop(string $message, int $exitCode = 1): never
{
    fwrite($exitCode === 0 ? STDOUT : STDERR, $message . PHP_EOL);
    exit($exitCode);
}

$args = $_SERVER['argv'] ?? [];
if (
    count($args) !== 3 ||
    !is_string($args[1] ?? null) ||
    !preg_match('/^[1-9][0-9]{0,9}$/D', $args[1]) ||
    ($args[2] ?? null) !== '--send'
) {
    testPushStop(
        'Usage: php push_notifications/test_push_cli.php <resident_user_id> --send'
    );
}

$residentId = (int) $args[1];
if ($residentId < 1) {
    testPushStop('Invalid resident user ID.');
}

$configPath = __DIR__ . '/../config/database.php';
$senderPath = __DIR__ . '/fcm_sender.php';

if (!is_file($configPath) || !is_readable($configPath)) {
    testPushStop('Missing or unreadable pawrescue_api/config/database.php.');
}
if (!is_file($senderPath) || !is_readable($senderPath)) {
    testPushStop('Missing or unreadable push_notifications/fcm_sender.php.');
}

try {
    require_once $configPath;
    require_once $senderPath;

    // Match the existing PawRescue PDO config without putting credentials
    // inside this test script. Supported patterns: Database::connect(),
    // Database::getConnection(), or a $conn/$pdo initialized by config.
    $db = null;
    if (class_exists('Database')) {
        $database = new Database();
        if (method_exists($database, 'getConnection')) {
            $db = $database->getConnection();
        }
        if (!($db instanceof PDO) && method_exists($database, 'connect')) {
            $db = $database->connect();
        }
    }
    if (!($db instanceof PDO)) {
        if (isset($conn) && $conn instanceof PDO) {
            $db = $conn;
        } elseif (isset($pdo) && $pdo instanceof PDO) {
            $db = $pdo;
        }
    }
    if (!($db instanceof PDO)) {
        testPushStop('Database config did not provide a PDO connection.');
    }

    // Choose one ACTIVE Android device belonging to the requested resident.
    // The token stays only in server-side memory and is never printed.
    $stmt = $db->prepare(
        'SELECT device_token
         FROM user_push_tokens
         WHERE user_id = :user_id
           AND is_active = 1
           AND platform = :platform
         ORDER BY last_seen_at DESC, id DESC
         LIMIT 1'
    );
    $stmt->execute([
        ':user_id' => $residentId,
        ':platform' => 'android',
    ]);

    $deviceToken = $stmt->fetchColumn();
    if (!is_string($deviceToken) || $deviceToken === '') {
        testPushStop(
            'No active Android device token found for resident ID ' . $residentId .
            '. Log in on the phone and verify user_push_tokens first.'
        );
    }

    fwrite(STDOUT, 'Sending one test push to resident ID ' . $residentId . '...' . PHP_EOL);

    $result = pawrescueSendFcmToToken(
        $deviceToken,
        'PawRescue Test Notification',
        'Firebase push notifications are connected to your PawRescue app.',
        [
            'type' => 'push_test',
            'route' => '/notifications',
        ]
    );

    if (($result['success'] ?? false) === true) {
        testPushStop(
            'SUCCESS: Firebase accepted the push request (HTTP 200). ' .
            'Check the phone notification tray. Acceptance does not guarantee display.',
            0
        );
    }

    $code = (string) ($result['error_code'] ?? 'UNKNOWN_ERROR');
    $status = $result['http_status'] ?? null;
    $httpLabel = is_int($status) ? 'HTTP ' . $status : 'No HTTP response';
    $retryable = ($result['retryable'] ?? false) ? ' (potentially retryable)' : '';

    if (($result['unregistered'] ?? false) === true) {
        testPushStop(
            'FAILED: Device token is no longer registered (UNREGISTERED). ' .
            'Log into PawRescue on the phone to refresh its token.'
        );
    }
    testPushStop('FAILED: Firebase send rejected — ' . $httpLabel . ', code: ' . $code . $retryable);
} catch (Throwable $e) {
    // Avoid echoing exception messages: a database/HTTP exception might
    // include connection details. Print only the exception class.
    testPushStop('FAILED: Test could not run (' . get_class($e) . '). Check PHP, database connection and private Firebase credentials.');
}
