<?php

// =====================================
// PAWRESCUE COMMUNITY
// CREATE STRAY ANIMAL ASSISTANCE REPORT
// Target: pawrescue_api/stray/create_report.php
// =====================================

// CORS is handled centrally by cors.php
// through the existing .htaccess rules.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// RESPONSE HELPER
// =====================================

function sendResponse(int $status, bool $success, string $message, array $extra = []): void
{
    http_response_code($status);

    echo json_encode(array_merge([
        "success" => $success,
        "message" => $message
    ], $extra));

    exit;
}

// =====================================
// PERFORMANCE MONITORING
// =====================================

$requestStart = microtime(true);

function logPerformance(string $stage, float $startTime): void
{
    $elapsed = round((microtime(true) - $startTime) * 1000, 2);

    error_log(
        "[PawRescue Stray Assistance Performance] " .
        $stage . ": " . $elapsed . " ms"
    );
}

// =====================================
// VALIDATE REQUEST METHOD
// =====================================

// Preflight OPTIONS requests are handled
// by the centralized CORS configuration.

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    sendResponse(405, false, "Method not allowed.");
}

// =====================================
// LOAD EXISTING AUTHENTICATION
// =====================================

require_once __DIR__ . "/../middleware/auth_middleware.php";

// =====================================
// VALIDATE CONTENT TYPE
// =====================================

if (stripos($_SERVER["CONTENT_TYPE"] ?? "", "application/json") === false) {
    sendResponse(415, false, "Content-Type must be application/json.");
}

try {
    // =====================================
    // AUTHENTICATE RESIDENT
    // =====================================

    $authStart = microtime(true);

    $auth = authenticate(["resident"]);
    $conn = $auth["connection"];
    $userId = (int) $auth["user"]["id"];

    logPerformance("Authentication", $authStart);

    // =====================================
    // READ JSON REQUEST BODY
    // =====================================

    $validationStart = microtime(true);

    $data = json_decode(file_get_contents("php://input"), true);

    if (!is_array($data) || array_is_list($data)) {
        sendResponse(400, false, "Invalid JSON request.");
    }

    // =====================================
    // REQUIRED FIELDS
    // =====================================

    $required = [
        "animal_type",
        "assistance_reason",
        "description",
        "incident_date",
        "location_address"
    ];

    foreach ($required as $field) {
        if (
            !isset($data[$field]) ||
            !is_string($data[$field]) ||
            trim($data[$field]) === ""
        ) {
            sendResponse(400, false, "Please complete all required fields.");
        }
    }

    // =====================================
    // EXTRACT DATA
    // =====================================

    $animalType = strtolower(trim($data["animal_type"]));
    $assistanceReason = strtolower(trim($data["assistance_reason"]));
    $description = trim($data["description"]);
    $incidentDate = trim($data["incident_date"]);
    $location = trim($data["location_address"]);
    $latitude = $data["latitude"] ?? null;
    $longitude = $data["longitude"] ?? null;

    // =====================================
    // VALIDATE ANIMAL TYPE
    // =====================================

    if (!in_array($animalType, ["dog", "cat"], true)) {
        sendResponse(400, false, "Invalid animal type.");
    }

    // =====================================
    // VALIDATE REASON FOR ASSISTANCE
    // =====================================

    $allowedReasons = [
        "injured",
        "sick",
        "trapped",
        "aggressive",
        "abandoned",
        "roaming",
        "other"
    ];

    if (!in_array($assistanceReason, $allowedReasons, true)) {
        sendResponse(400, false, "Invalid reason for assistance.");
    }

    // =====================================
    // VALIDATE DESCRIPTION AND LOCATION
    // =====================================

    if (mb_strlen($description) > 5000 || mb_strlen($location) > 255) {
        sendResponse(400, false, "Description or location is too long.");
    }

    // =====================================
    // VALIDATE INCIDENT DATE
    // =====================================

    $date = DateTimeImmutable::createFromFormat("!Y-m-d", $incidentDate);

    if (!$date || $date->format("Y-m-d") !== $incidentDate) {
        sendResponse(400, false, "Invalid incident date.");
    }

    if ($date > new DateTimeImmutable("today")) {
        sendResponse(400, false, "Incident date cannot be in the future.");
    }

    // =====================================
    // VALIDATE OPTIONAL GPS COORDINATES
    // =====================================

    // Either provide BOTH latitude and longitude,
    // or omit BOTH for a manually entered location.

    if (($latitude === null) !== ($longitude === null)) {
        sendResponse(400, false, "Both coordinates are required.");
    }

    if ($latitude !== null) {
        if (
            !is_numeric($latitude) ||
            !is_numeric($longitude) ||
            !is_finite((float) $latitude) ||
            !is_finite((float) $longitude) ||
            (float) $latitude < -90 ||
            (float) $latitude > 90 ||
            (float) $longitude < -180 ||
            (float) $longitude > 180
        ) {
            sendResponse(400, false, "Invalid coordinates.");
        }

        $latitude = (float) $latitude;
        $longitude = (float) $longitude;
    }

    logPerformance("Validation", $validationStart);

    // =====================================
    // INSERT STRAY ANIMAL REPORT
    // =====================================

    // The separate stray_reports table must
    // be created before using this endpoint.
    // Its column definitions will be added
    // in the next implementation step.

    $databaseStart = microtime(true);

    $stmt = $conn->prepare(
        "INSERT INTO stray_reports
        (
            user_id,
            animal_type,
            assistance_reason,
            description,
            incident_date,
            location_address,
            latitude,
            longitude,
            status
        )
        VALUES
        (
            :user_id,
            :animal_type,
            :assistance_reason,
            :description,
            :incident_date,
            :location_address,
            :latitude,
            :longitude,
            'pending'
        )"
    );

    $stmt->execute([
        ":user_id" => $userId,
        ":animal_type" => $animalType,
        ":assistance_reason" => $assistanceReason,
        ":description" => $description,
        ":incident_date" => $incidentDate,
        ":location_address" => $location,
        ":latitude" => $latitude,
        ":longitude" => $longitude
    ]);

    $reportId = (int) $conn->lastInsertId();

    logPerformance("Database Insert", $databaseStart);
    logPerformance("Total Request", $requestStart);

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    sendResponse(201, true, "Stray animal assistance report submitted successfully!", [
        "report_id" => $reportId,
        "status" => "pending"
    ]);

} catch (Throwable $e) {
    error_log("[PawRescue Create Stray Report Error] " . $e->getMessage());
    logPerformance("Failed Request", $requestStart);

    sendResponse(500, false, "Unable to submit report. Please try again.");
}
