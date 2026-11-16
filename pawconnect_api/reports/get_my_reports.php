<?php

// =====================================
// PAWRESCUE COMMUNITY
// GET LOGGED-IN RESIDENT'S PET REPORTS
// =====================================

// CORS is automatically handled by
// cors.php through .htaccess.

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

// =====================================
// JSON RESPONSE HELPER
// =====================================

function sendMyReportsResponse(
    int $status,
    array $data
): void {

    http_response_code($status);

    echo json_encode($data);

    exit;
}

// =====================================
// VALIDATE REQUEST METHOD
// =====================================

// OPTIONS is handled by centralized cors.php.

if ($_SERVER["REQUEST_METHOD"] !== "GET") {

    header("Allow: GET, OPTIONS");

    sendMyReportsResponse(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

// =====================================
// AUTHENTICATION MIDDLEWARE
// =====================================

require_once __DIR__ .
    "/../middleware/auth_middleware.php";

try {

    // =====================================
    // AUTHENTICATE RESIDENT ONLY
    // =====================================

    $auth = authenticate(["resident"]);

    $conn = $auth["connection"];

    // Get the user ID from the verified token,
    // never from the frontend request.

    $residentId = (int) $auth["user"]["id"];

    // =====================================
    // VALIDATE REPORT FILTER
    // =====================================

    $reportType = $_GET["type"] ?? "all";

    if (
        !is_string($reportType) ||
        !in_array(
            $reportType,
            ["all", "lost", "found"],
            true
        )
    ) {

        sendMyReportsResponse(400, [
            "success" => false,
            "message" => "Invalid report filter."
        ]);
    }

    // =====================================
    // RETRIEVE OWN LOST/FOUND REPORTS
    // =====================================

    $sql = "
        SELECT
            p.id,
            p.report_type,
            p.animal_type,
            p.pet_name,
            p.description,
            p.photo_path,
            p.incident_date,
            p.location_address,
            p.latitude,
            p.longitude,
            p.status,
            p.created_at,
            u.full_name AS reporter_name
        FROM pet_reports p
        INNER JOIN users u
            ON u.id = p.user_id
        WHERE p.user_id = :resident_id
          AND p.report_type IN ('lost', 'found')
    ";

    $params = [
        ":resident_id" => $residentId
    ];

    // =====================================
    // OPTIONAL TYPE FILTER
    // =====================================

    if ($reportType !== "all") {

        $sql .= "
            AND p.report_type = :report_type
        ";

        $params[":report_type"] = $reportType;
    }

    // =====================================
    // NEWEST REPORTS FIRST
    // =====================================

    $sql .= "
        ORDER BY
            p.created_at DESC,
            p.id DESC
        LIMIT 100
    ";

    // =====================================
    // EXECUTE REPORT QUERY
    // =====================================

    $stmt = $conn->prepare($sql);

    $stmt->execute($params);

    $reports = $stmt->fetchAll(
        PDO::FETCH_ASSOC
    );

    // =====================================
    // PREPARE MULTIPLE-PHOTO FIELDS
    // =====================================

    // Keep the legacy photo_path field unchanged.
    // The new photos array contains the records
    // from pet_report_photos in display order.

    $reportIndexes = [];
    $reportIds = [];

    foreach ($reports as $index => $report) {

        $reportId = (int) $report["id"];

        $reports[$index]["photos"] = [];
        $reports[$index]["photo_count"] = 0;

        $reportIndexes[$reportId] = $index;
        $reportIds[] = $reportId;
    }

    // =====================================
    // RETRIEVE ALL MATCHING REPORT PHOTOS
    // =====================================

    // Use one batch query to prevent an extra
    // database query for each individual report.

    if (!empty($reportIds)) {

        $placeholders = implode(
            ", ",
            array_fill(0, count($reportIds), "?")
        );

        $photoSql = "
            SELECT
                id,
                report_id,
                photo_path,
                sort_order,
                created_at
            FROM pet_report_photos
            WHERE report_id IN ($placeholders)
            ORDER BY
                report_id ASC,
                sort_order ASC,
                id ASC
        ";

        $photoStmt = $conn->prepare($photoSql);

        foreach ($reportIds as $position => $reportId) {

            $photoStmt->bindValue(
                $position + 1,
                $reportId,
                PDO::PARAM_INT
            );
        }

        $photoStmt->execute();

        $photos = $photoStmt->fetchAll(
            PDO::FETCH_ASSOC
        );

        // =====================================
        // ATTACH PHOTOS TO THEIR REPORTS
        // =====================================

        foreach ($photos as $photo) {

            $reportId = (int) $photo["report_id"];

            if (!isset($reportIndexes[$reportId])) {
                continue;
            }

            $index = $reportIndexes[$reportId];

            $reports[$index]["photos"][] = [
                "id" => (int) $photo["id"],
                "photo_path" => $photo["photo_path"],
                "sort_order" => (int) $photo["sort_order"],
                "created_at" => $photo["created_at"]
            ];

            $reports[$index]["photo_count"]++;
        }
    }

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    sendMyReportsResponse(200, [
        "success" => true,
        "message" => "My reports retrieved successfully.",
        "count" => count($reports),
        "reports" => $reports
    ]);

} catch (Throwable $e) {

    error_log(
        "[PawRescue Get My Reports Error] " .
        $e->getMessage()
    );

    sendMyReportsResponse(500, [
        "success" => false,
        "message" => "Unable to retrieve your reports."
    ]);
}
