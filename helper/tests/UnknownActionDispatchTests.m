#import <Foundation/Foundation.h>

static NSMutableArray *messages;

@interface FixtureController : NSObject
- (void)sendMessage:(NSDictionary *)message;
@end
@implementation FixtureController
- (void)sendMessage:(NSDictionary *)message { [messages addObject:message]; }
@end

static void RunUnknownAction(NSString *event, NSDictionary *data, NSString *transaction, FixtureController *controller) {
    (void)event;
    (void)data;
/* OPENCLAW_UNKNOWN_ACTION_ELSE */
}

static void Expect(BOOL condition, const char *message) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}

int main(void) {
    @autoreleasepool {
        messages = [NSMutableArray array];
        RunUnknownAction(@"not-a-real-action", @{}, @"tx", [FixtureController new]);
        Expect(messages.count == 1, "unknown action must send one reply");
        Expect([messages.lastObject[@"transactionId"] isEqual:@"tx"], "reply must keep the caller transaction");
        Expect([messages.lastObject[@"error"] isEqual:@"Unknown action"], "reply must name the unknown action");
        messages = [NSMutableArray array];
        RunUnknownAction(@"not-a-real-action", @{}, nil, [FixtureController new]);
        Expect(messages.count == 0, "unknown action without a transaction must not reply");
        fputs("PASS: unknown authenticated actions return a transaction error\n", stderr);
    }
    return 0;
}
