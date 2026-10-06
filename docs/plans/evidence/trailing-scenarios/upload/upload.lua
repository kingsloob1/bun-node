wrk.method = "POST"
wrk.body = "--BunNodeBenchBoundary\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nv\r\n--BunNodeBenchBoundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n" .. string.rep("x", 1024) .. "\r\n--BunNodeBenchBoundary--\r\n"
wrk.headers["Content-Type"] = "multipart/form-data; boundary=BunNodeBenchBoundary"
