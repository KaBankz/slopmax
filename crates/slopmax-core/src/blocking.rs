//! Work that blocks (the disk, file locks) run off the thread that serves
//! requests, which on the default one-thread runtime is the only one.

use tokio::sync::oneshot;

/// Runs `work` on a blocking thread and returns what it returns. A panic
/// in `work` panics here, as it would have inline.
pub async fn run<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = oneshot::channel();
    // One boxed job type, so every caller shares one copy of tokio's
    // blocking-task code rather than each building its own.
    let job: Box<dyn FnOnce() + Send> = Box::new(move || {
        let _ = tx.send(work());
    });
    if let Err(e) = tokio::task::spawn_blocking(job).await
        && let Ok(panic) = e.try_into_panic()
    {
        std::panic::resume_unwind(panic);
    }
    rx.await
        .expect("blocking work either answers or panics, and a panic resumed above")
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn answers_from_another_thread() {
        let here = std::thread::current().id();
        let there = super::run(|| std::thread::current().id()).await;
        assert_ne!(here, there);
    }

    #[tokio::test]
    #[should_panic(expected = "the disk caught fire")]
    async fn a_panic_reaches_the_caller() {
        super::run(|| panic!("the disk caught fire")).await;
    }
}
