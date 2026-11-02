<?php
/**
 * PawRescue Community — Step 6.2
 * File: pawrescue_api/push_notifications/fcm_sender.php
 *
 * INTERNAL SERVER-SIDE HELPER ONLY — not a public API endpoint.
 *
 * Sends an Android push notification to ONE FCM device token using
 * Firebase Cloud Messaging HTTP v1 and a private service-account key.
 * The future notification dispatcher will select active, authorized
 * recipient tokens from user_push_tokens, then call this helper.
 *
 * Requirements: PHP 8.1+, cURL, OpenSSL, outbound HTTPS to Google.
 * No Composer packages needed for this development implementation.
 *
 * Service account location (established in Step 6.1):
 *   C:\xampp\pawrescue_private\firebase\service-account.json
 *
 * Optional deployment override:
 *   PAWRESCUE_FIREBASE_SERVICE_ACCOUNT=/absolute/private/key.json
 *
 * Example (SERVER-SIDE CODE ONLY; never expose this as a public send API):
 *   require_once __DIR__ . '/fcm_sender.php';
 *   $result = pawrescueSendFcmToToken(
 *       $row['device_token'],
 *       'Lost Pet Recovery',
 *       'Your pickup schedule has been approved.',
 *       ['type' => 'lost_recovery', 'route' => '/my-recoveries']
 *   );
 *
 * Result keys:
 *   success, message_id, http_status, error_code, unregistered, retryable
 *
 * Security:
 * - Never accept a device token directly from an unauthenticated request.
 * - Never expose this helper as a user-callable send endpoint.
 * - Never log tokens, access tokens, JWTs, or the private service-account key.
 * - Do not turn off SSL certificate validation.
 */

declare(strict_types=1);

// Opening this PHP file directly via HTTP must not send anything.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME'])) {
    $executed = realpath((string) $_SERVER['SCRIPT_FILENAME']);
    if ($executed !== false && $executed === realpath(__FILE__)) {
        http_response_code(404);
        exit;
    }
}

/** URL-safe Base64 encoding required by service-account JWT assertions. */
function pawrescueFcmBase64Url(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

/**
 * Read only the private service-account JSON; never read a key from htdocs.
 * The derived default path is C:/xampp/pawrescue_private/firebase on XAMPP.
 *
 * @return array{project_id: string, client_email: string, private_key: string}
 */
function pawrescueFcmCredentials(): array
{
    $override = getenv('PAWRESCUE_FIREBASE_SERVICE_ACCOUNT');
    $path = is_string($override) && trim($override) !== ''
        ? trim($override)
        : dirname(__DIR__, 4)
            . DIRECTORY_SEPARATOR . 'pawrescue_private'
            . DIRECTORY_SEPARATOR . 'firebase'
            . DIRECTORY_SEPARATOR . 'service-account.json';

    if (!is_file($path) || !is_readable($path)) {
        throw new RuntimeException('FCM credentials file is missing or unreadable.');
    }

    $raw = file_get_contents($path);
    if ($raw === false) {
        throw new RuntimeException('FCM credentials could not be read.');
    }

    $credentials = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($credentials)) {
        throw new RuntimeException('FCM credentials have an invalid format.');
    }

    $projectId = $credentials['project_id'] ?? null;
    $clientEmail = $credentials['client_email'] ?? null;
    $privateKey = $credentials['private_key'] ?? null;

    if (
        !is_string($projectId) ||
        !preg_match('/^[a-z0-9][a-z0-9-]{0,62}$/', $projectId) ||
        !is_string($clientEmail) ||
        !filter_var($clientEmail, FILTER_VALIDATE_EMAIL) ||
        !is_string($privateKey) ||
        !str_contains($privateKey, 'BEGIN PRIVATE KEY')
    ) {
        throw new RuntimeException('FCM service-account credentials are incomplete.');
    }

    return [
        'project_id' => $projectId,
        'client_email' => $clientEmail,
        'private_key' => $privateKey,
    ];
}

/**
 * Perform a secure outbound HTTPS POST.
 *
 * @param list<string> $headers
 * @return array{status: int, body: string}
 */
function pawrescueFcmPost(string $url, string $body, array $headers): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL extension is not enabled.');
    }

    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Could not initialize cURL.');
    }

    try {
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 25,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);

        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($response === false) {
            // Do not include request contents, private keys or access tokens in logs.
            throw new RuntimeException('An HTTPS connection to Google failed.');
        }

        return ['status' => $status, 'body' => (string) $response];
    } finally {
        curl_close($ch);
    }
}

/**
 * Exchange a signed service-account JWT for an OAuth 2.0 access token.
 * Access token is reused only within the current PHP request/process.
 */
function pawrescueFcmAccessToken(array $credentials): string
{
    static $cachedToken = null;
    static $cachedUntil = 0;

    if (is_string($cachedToken) && time() < $cachedUntil) {
        return $cachedToken;
    }

    if (!function_exists('openssl_sign')) {
        throw new RuntimeException('PHP OpenSSL extension is not enabled.');
    }

    $now = time();
    $header = ['alg' => 'RS256', 'typ' => 'JWT'];
    $claims = [
        'iss' => $credentials['client_email'],
        'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
        'aud' => 'https://oauth2.googleapis.com/token',
        'iat' => $now - 30,
        'exp' => $now + 3300,
    ];

    $unsigned = pawrescueFcmBase64Url(json_encode($header, JSON_THROW_ON_ERROR))
        . '.'
        . pawrescueFcmBase64Url(json_encode($claims, JSON_THROW_ON_ERROR));

    $signature = '';
    if (!openssl_sign(
        $unsigned,
        $signature,
        $credentials['private_key'],
        OPENSSL_ALGO_SHA256
    )) {
        throw new RuntimeException('Could not sign service-account assertion.');
    }

    $assertion = $unsigned . '.' . pawrescueFcmBase64Url($signature);
    $form = http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion' => $assertion,
    ], '', '&', PHP_QUERY_RFC3986);

    $response = pawrescueFcmPost(
        'https://oauth2.googleapis.com/token',
        $form,
        ['Content-Type: application/x-www-form-urlencoded']
    );

    $result = json_decode($response['body'], true);
    if (
        $response['status'] !== 200 ||
        !is_array($result) ||
        !isset($result['access_token']) ||
        !is_string($result['access_token']) ||
        $result['access_token'] === ''
    ) {
        throw new RuntimeException('Google rejected the FCM service-account authorization.');
    }

    $expiresIn = max(60, (int) ($result['expires_in'] ?? 3600));
    $cachedToken = $result['access_token'];
    $cachedUntil = time() + $expiresIn - 60;

    return $cachedToken;
}

/**
 * Send one notification to an already-authorized FCM device token.
 * A future caller must choose tokens from the authenticated recipient's
 * ACTIVE rows in user_push_tokens; this function does not choose recipients.
 *
 * @param array<string, scalar|null> $data FCM data values become strings.
 * @return array{
 *   success: bool,
 *   message_id: ?string,
 *   http_status: ?int,
 *   error_code: ?string,
 *   unregistered: bool,
 *   retryable: bool
 * }
 */
function pawrescueSendFcmToToken(
    string $deviceToken,
    string $title,
    string $body,
    array $data = []
): array {
    $failed = [
        'success' => false,
        'message_id' => null,
        'http_status' => null,
        'error_code' => 'INTERNAL_ERROR',
        'unregistered' => false,
        'retryable' => false,
    ];

    try {
        $deviceToken = trim($deviceToken);
        $title = trim($title);
        $body = trim($body);

        if (
            strlen($deviceToken) < 20 ||
            strlen($deviceToken) > 1024 ||
            preg_match('/[^\x21-\x7E]/', $deviceToken) ||
            $title === '' ||
            strlen($title) > 200 ||
            $body === '' ||
            strlen($body) > 1000
        ) {
            $failed['error_code'] = 'INVALID_ARGUMENT';
            return $failed;
        }

        $safeData = [];
        if (count($data) > 20) {
            $failed['error_code'] = 'INVALID_ARGUMENT';
            return $failed;
        }

        foreach ($data as $key => $value) {
            if (
                !is_string($key) ||
                !preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,63}$/', $key) ||
                str_starts_with(strtolower($key), 'google') ||
                str_starts_with(strtolower($key), 'gcm') ||
                !(is_scalar($value) || $value === null)
            ) {
                $failed['error_code'] = 'INVALID_ARGUMENT';
                return $failed;
            }
            $safeData[$key] = $value === null ? '' : (string) $value;
        }

        $credentials = pawrescueFcmCredentials();
        $accessToken = pawrescueFcmAccessToken($credentials);

        $message = [
            'token' => $deviceToken,
            'notification' => ['title' => $title, 'body' => $body],
            'android' => ['priority' => 'HIGH'],
        ];
        if ($safeData !== []) {
            $message['data'] = $safeData;
        }

        $payload = json_encode(
            ['message' => $message],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE
        );

        $url = 'https://fcm.googleapis.com/v1/projects/'
            . rawurlencode($credentials['project_id'])
            . '/messages:send';

        $response = pawrescueFcmPost($url, $payload, [
            'Authorization: Bearer ' . $accessToken,
            'Content-Type: application/json; charset=UTF-8',
        ]);

        $status = $response['status'];
        $decoded = json_decode($response['body'], true);

        if (
            $status === 200 &&
            is_array($decoded) &&
            isset($decoded['name']) &&
            is_string($decoded['name'])
        ) {
            return [
                'success' => true,
                'message_id' => $decoded['name'],
                'http_status' => 200,
                'error_code' => null,
                'unregistered' => false,
                'retryable' => false,
            ];
        }

        // Return machine-readable error metadata without echoing the response
        // body, which could contain sensitive request or token information.
        $errorCode = 'FCM_REQUEST_FAILED';
        $details = is_array($decoded) ? ($decoded['error']['details'] ?? []) : [];
        if (is_array($details)) {
            foreach ($details as $detail) {
                if (is_array($detail) && is_string($detail['errorCode'] ?? null)) {
                    $errorCode = $detail['errorCode'];
                    break;
                }
            }
        }
        if (
            $errorCode === 'FCM_REQUEST_FAILED' &&
            is_array($decoded) &&
            is_string($decoded['error']['status'] ?? null)
        ) {
            $errorCode = $decoded['error']['status'];
        }

        return [
            'success' => false,
            'message_id' => null,
            'http_status' => $status,
            'error_code' => $errorCode,
            'unregistered' => $errorCode === 'UNREGISTERED',
            'retryable' => ($status === 429 || $status >= 500),
        ];
    } catch (Throwable $e) {
        // Do not expose credential contents, JWTs or device registration tokens.
        error_log('[PawRescue FCM Sender] Internal error (' . get_class($e) . ').');
        return $failed;
    }
}
