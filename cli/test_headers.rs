use http::Request;

fn main() {
    let builder = Request::builder()
        .header(http::header::CONTENT_TYPE, "*/*")
        .header(http::header::CONTENT_TYPE, "application/octet-stream");
    
    let req = builder.body(()).unwrap();
    
    println!("Content-Type headers:");
    for value in req.headers().get_all(http::header::CONTENT_TYPE) {
        println!("  {:?}", value);
    }
}
