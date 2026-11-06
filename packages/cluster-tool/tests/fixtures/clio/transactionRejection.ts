/** The failed clio JSON trace from the node-owner flow, reduced to rejection evidence. */
export const TransactionRejection = {
  transaction_id:
    "1f7ac8204c4675837188d08b9de920ccee661dba01755575f6be855bb70ea83b",
  processed: {
    id: "1f7ac8204c4675837188d08b9de920ccee661dba01755575f6be855bb70ea83b",
    receipt: null,
    except: {
      code: 3050003,
      name: "sysio_assert_message_exception",
      message: "sysio_assert_message assertion failure",
      stack: [
        {
          msg: "assertion failure with message: Tier level must be between 1 and 3"
        }
      ]
    }
  }
}
