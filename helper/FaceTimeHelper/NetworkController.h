//
//  NetworkController.h
//  FaceTimeHelper
//
//  Created by Samer Shihabi on 11/20/20.
//  OpenClaw FaceTime helper.
//

#ifndef NetworkController_h
#define NetworkController_h
#import "GCDAsyncSocket.h"

// Block typedefs
@class GCDAsyncSocket;
typedef void (^MessageBlock)(id,NSString*);

@interface NetworkController : NSObject<GCDAsyncSocketDelegate> {
    GCDAsyncSocket *asyncSocket;
    MessageBlock messageReceivedBlock;
}

// Singleton instance
+ (NetworkController*)sharedInstance;

// Methods
- (void)connect;
- (void)disconnect;
- (void)sendMessage:(NSDictionary*)message;

@property (copy) MessageBlock messageReceivedBlock;

@end
#endif /* NetworkController_h */
