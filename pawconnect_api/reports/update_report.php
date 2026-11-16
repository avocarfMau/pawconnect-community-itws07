
<?php

// =====================================
// PAWRESCUE COMMUNITY
// UPDATE LOST OR FOUND PET REPORT
// =====================================

// CORS is automatically handled by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// RESPONSE HELPER
// =====================================

function sendUpdateResponse(
    $status,
    $success,
    $message,
    $extra = []
) {
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

function logUpdatePerformance(
    $stage,
    $startTime
) {
    $elapsed = round(
        (microtime(true) - $startTime) * 1000,
        2
    );

    error_log(
        "[PawRescue Update Performance] " .
        $stage . ": " .
        $elapsed . " ms"
    );
}

// =====================================
// VALIDATE REQUEST METHOD
// =====================================

// OPTIONS requests are already
// handled by centralized cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "POST") {

    header("Allow: POST, OPTIONS");

    sendUpdateResponse(
        405,
        false,
        "Method not allowed."
    );
}

// =====================================
// LOAD AUTHENTICATION
// =====================================

require_once __DIR__ .
    "/../middleware/auth_middleware.php";

// =====================================
// VALIDATE CONTENT TYPE
// =====================================

if (
    stripos(
        $_SERVER["CONTENT_TYPE"] ?? "",
        "application/json"
    ) === false
) {
    sendUpdateResponse(
        415,
        false,
        "Content-Type must be application/json."
    );
}

try {

    // =====================================
    // AUTHENTICATE RESIDENT
    // =====================================

    $authStart = microtime(true);

    $auth = authenticate(["resident"]);

    $conn = $auth["connection"];
    $userId = (int) $auth["user"]["id"];

    logUpdatePerformance(
        "Authentication",
        $authStart
    );

    // =====================================
    // READ REQUEST DATA
    // =====================================

    $validationStart = microtime(true);

    $data = json_decode(
        file_get_contents("php://input"),
        true
    );

    if (
        !is_array($data) ||
        array_is_list($data)
    ) {
        sendUpdateResponse(
            400,
            false,
            "Invalid JSON request."
        );
    }

    // =====================================
    // VALIDATE REPORT ID
    // =====================================

    $reportId = filter_var(
        $data["report_id"] ?? null,
        FILTER_VALIDATE_INT,
        [
            "options" => [
                "min_range" => 1
            ]
        ]
    );

    if ($reportId === false || $reportId === null) {

        sendUpdateResponse(
            400,
            false,
            "Invalid report ID."
        );
    }

    // =====================================
    // REQUIRED FIELDS
    // =====================================

    $required = [
        "report_type",
        "animal_type",
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
            sendUpdateResponse(
                400,
                false,
                "Please complete all required fields."
            );
        }
    }

    // =====================================
    // EXTRACT DATA
    // =====================================

    $reportType = trim(
        $data["report_type"]
    );

    $animalType = trim(
        $data["animal_type"]
    );

    $description = trim(
        $data["description"]
    );

    $incidentDate = trim(
        $data["incident_date"]
    );

    $location = trim(
        $data["location_address"]
    );

    $petName = $data["pet_name"] ?? null;
    $latitude = $data["latitude"] ?? null;
    $longitude = $data["longitude"] ?? null;

    // =====================================
    // VALIDATE REPORT TYPE
    // =====================================

    if (!in_array(
        $reportType,
        ["lost", "found"],
        true
    )) {
        sendUpdateResponse(
            400,
            false,
            "Invalid report type."
        );
    }

    // =====================================
    // VALIDATE ANIMAL TYPE
    // =====================================

    if (!in_array(
        $animalType,
        ["dog", "cat"],
        true
    )) {
        sendUpdateResponse(
            400,
            false,
            "Invalid animal type."
        );
    }

    // =====================================
    // VALIDATE TEXT LENGTHS
    // =====================================

    if (
        mb_strlen($description) > 5000 ||
        mb_strlen($location) > 255
    ) {
        sendUpdateResponse(
            400,
            false,
            "Description or location is too long."
        );
    }

    // =====================================
    // VALIDATE OPTIONAL PET NAME
    // =====================================

    if ($petName !== null) {

        if (
            !is_string($petName) ||
            mb_strlen($petName) > 100
        ) {
            sendUpdateResponse(
                400,
                false,
                "Invalid pet name."
            );
        }

        $petName = trim($petName);

        if ($petName === "") {
            $petName = null;
        }
    }

    // =====================================
    // VALIDATE INCIDENT DATE
    // =====================================

    $date = DateTimeImmutable::createFromFormat(
        "!Y-m-d",
        $incidentDate
    );

    if (
        !$date ||
        $date->format("Y-m-d") !== $incidentDate
    ) {
        sendUpdateResponse(
            400,
            false,
            "Invalid incident date."
        );
    }

    if (
        $date > new DateTimeImmutable("today")
    ) {
        sendUpdateResponse(
            400,
            false,
            "Incident date cannot be in the future."
        );
    }

    // =====================================
    // VALIDATE GPS COORDINATES
    // =====================================

    // Latitude and longitude must both
    // be provided or both be null.

    if (
        ($latitude === null) !==
        ($longitude === null)
    ) {
        sendUpdateResponse(
            400,
            false,
            "Both coordinates are required."
        );
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
            sendUpdateResponse(
                400,
                false,
                "Invalid coordinates."
            );
        }
    }

    logUpdatePerformance(
        "Validation",
        $validationStart
    );

    // =====================================
    // VERIFY REPORT OWNERSHIP AND STATUS
    // =====================================

    $databaseStart = microtime(true);

    $stmt = $conn->prepare(
        "SELECT id, status
        FROM pet_reports
        WHERE id = :report_id
          AND user_id = :user_id
          AND report_type IN ('lost', 'found')
        LIMIT 1"
    );

    $stmt->execute([
        ":report_id" => $reportId,
        ":user_id" => $userId
    ]);

    $report = $stmt->fetch(
        PDO::FETCH_ASSOC
    );

    if (!$report) {

        sendUpdateResponse(
            404,
            false,
            "Report not found or access denied."
        );
    }

    if (!in_array(
        $report["status"],
        ["pending", "under_review", "in_progress"],
        true
    )) {
        sendUpdateResponse(
            409,
            false,
            "Resolved or closed reports cannot be edited."
        );
    }

    // =====================================
    // UPDATE PET REPORT IN DATABASE
    // =====================================

    $update = $conn->prepare(
        "UPDATE pet_reports
        SET
            report_type = :report_type,
            animal_type = :animal_type,
            pet_name = :pet_name,
            description = :description,
            incident_date = :incident_date,
            location_address = :location_address,
            latitude = :latitude,
            longitude = :longitude,
            updated_at = NOW()
        WHERE id = :report_id
          AND user_id = :user_id
          AND status IN ('pending', 'under_review', 'in_progress')"
    );

    $update->execute([
        ":report_type" => $reportType,
        ":animal_type" => $animalType,
        ":pet_name" => $petName,
        ":description" => $description,
        ":incident_date" => $incidentDate,
        ":location_address" => $location,
        ":latitude" => $latitude,
        ":longitude" => $longitude,
        ":report_id" => $reportId,
        ":user_id" => $userId
    ]);

    if ($update->rowCount() !== 1) {

        sendUpdateResponse(
            409,
            false,
            "Report could not be updated. Please refresh and try again."
        );
    }

    logUpdatePerformance(
        "Database Update",
        $databaseStart
    );

    // =====================================
    // TOTAL PROCESSING TIME
    // =====================================

    logUpdatePerformance(
        "Total Request",
        $requestStart
    );

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    sendUpdateResponse(
        200,
        true,
        "Pet report updated successfully!",
        [
            "report_id" => (int) $reportId
        ]
    );

} catch (Throwable $e) {

    error_log(
        "[PawRescue Update Report Error] " .
        $e->getMessage()
    );

    logUpdatePerformance(
        "Failed Request",
        $requestStart
    );

    sendUpdateResponse(
        500,
        false,
        "Unable to update report. Please try again."
    );
}
